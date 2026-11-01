package com.stepcam.app

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.ImageFormat
import android.graphics.Rect
import android.graphics.YuvImage
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import com.herohan.uvcapp.CameraHelper
import com.herohan.uvcapp.ICameraHelper
import com.serenegiant.usb.IFrameCallback
import com.serenegiant.usb.Size
import com.serenegiant.usb.UVCCamera
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.ArrayDeque

/**
 * Drives a USB (UVC) webcam such as a Logitech C270/C920 through the phone's USB-C OTG port.
 *
 * - Frames arrive from the UVC driver as NV21; the last ~1.5 s of frames are kept in memory.
 * - Live preview:  https://appassets.androidplatform.net/usbcam/frame.jpg  (newest frame)
 * - Capture:       https://appassets.androidplatform.net/usbcam/still.jpg  (SHARPEST recent frame)
 * - A watchdog restarts the camera if frames stop, stepping down to a safer video mode each time.
 */
class UsbCam(private val activity: Activity) {

    private class Frame(val nv21: ByteArray, val w: Int, val h: Int, var time: Long)

    private val main = Handler(Looper.getMainLooper())
    private val prefs = activity.getSharedPreferences("stepcam", Context.MODE_PRIVATE)
    private val usbManager = activity.getSystemService(Context.USB_SERVICE) as UsbManager

    private val ring = ArrayDeque<Frame>()      // guarded by `ring`
    private val spare = ArrayDeque<ByteArray>() // recycled buffers, guarded by `ring`

    @Volatile private var helper: ICameraHelper? = null
    @Volatile private var state = "idle"
    @Volatile private var message = ""
    @Volatile private var deviceName = ""
    @Volatile private var width = 0
    @Volatile private var height = 0
    @Volatile private var lastFrameAt = 0L
    @Volatile private var streamStartedAt = 0L
    @Volatile private var frameSizes: List<Pair<Int, Int>> = emptyList()
    @Volatile private var fallbackLevel = 0     // 0 = best mode; higher = safer/smaller modes
    @Volatile private var restarts = 0
    @Volatile private var running = false
    private var selecting: String? = null

    /** Serves frames to the WebView. */
    val pathHandler = WebViewAssetLoader.PathHandler { path -> serve(path) }

    // ------------------------------------------------------------------ lifecycle

    fun start() {
        running = true
        main.removeCallbacks(watchdog)
        main.postDelayed(watchdog, WATCHDOG_MS)
        if (helper != null) return
        if (!hasCameraPermission()) {
            state = "no_camera_permission"
            return
        }
        state = "searching"
        try {
            helper = CameraHelper().also { it.setStateCallback(stateCallback) }
        } catch (e: Exception) {
            Log.e(TAG, "CameraHelper init failed", e)
            state = "error"
            message = e.message ?: "Could not start the USB camera driver"
            return
        }
        // If the library does not report an already-plugged-in camera, look for it ourselves.
        main.postDelayed({ if (helper != null && (state == "searching" || state == "no_device")) connect() }, 1200)
    }

    fun stop() {
        running = false
        main.removeCallbacks(watchdog)
        releaseHelper()
        state = "idle"
    }

    private fun releaseHelper() {
        val h = helper ?: return
        helper = null
        selecting = null
        try {
            h.release()
        } catch (e: Exception) {
            Log.w(TAG, "release failed", e)
        }
        synchronized(ring) { ring.clear(); spare.clear() }
    }

    /** Called from the UI's "Connect" button, from the USB-attached intent, or after permission is granted. */
    fun connect() {
        main.post {
            if (!hasCameraPermission()) {
                state = "no_camera_permission"
                (activity as? MainActivity)?.requestCameraPermission()
                return@post
            }
            if (state == "error") { restarts = 0; fallbackLevel = 0 }
            if (helper == null) start()
            val dev = findVideoDevice()
            if (dev == null) {
                state = "no_device"
                return@post
            }
            if (state == "denied" || state == "error" || state == "closed") selecting = null
            select(dev)
        }
    }

    fun setResolution(maxHeight: Int) {
        prefs.edit().putInt("maxHeight", maxHeight).apply()
        main.post {
            fallbackLevel = 0
            restarts = 0
            releaseHelper()
            start()
        }
    }

    fun statusJson(): String {
        val s = if (helper == null && !hasCameraPermission()) "no_camera_permission" else state
        return JSONObject()
            .put("state", s)
            .put("device", deviceName)
            .put("width", width)
            .put("height", height)
            .put("message", message)
            .put("fallback", fallbackLevel)
            .toString()
    }

    // ------------------------------------------------------------------ watchdog

    private val watchdog: Runnable = object : Runnable {
        override fun run() {
            if (!running) return
            val now = System.currentTimeMillis()
            val waitingForVideo = state == "opening" || state == "streaming"
            val since = maxOf(lastFrameAt, streamStartedAt)
            if (helper != null && waitingForVideo && since > 0 && now - since > STALL_MS) {
                if (restarts >= MAX_RESTARTS) {
                    Log.w(TAG, "Webcam still silent after $restarts restarts; giving up until Connect is tapped")
                    releaseHelper()
                    state = "error"
                    message = "The webcam stopped sending video."
                } else {
                    restarts++
                    if (lastFrameAt < streamStartedAt) fallbackLevel++ // this mode never produced a frame: try a safer one
                    Log.w(TAG, "No frames for ${now - since} ms; restart #$restarts at fallback level $fallbackLevel")
                    message = "Restarting the webcam…"
                    releaseHelper()
                    streamStartedAt = 0
                    start()
                    main.postDelayed({ connect() }, 600)
                }
            }
            main.postDelayed(this, WATCHDOG_MS)
        }
    }

    // ------------------------------------------------------------------ UVC callbacks

    private val stateCallback = object : ICameraHelper.StateCallback {
        override fun onAttach(device: UsbDevice) {
            if (isVideoDevice(device)) select(device)
        }

        override fun onDeviceOpen(device: UsbDevice, isFirstOpen: Boolean) {
            state = "opening"
            try {
                helper?.openCamera()
            } catch (e: Exception) {
                fail("Could not open the camera", e)
            }
        }

        override fun onCameraOpen(device: UsbDevice) {
            startStreaming()
        }

        override fun onCameraClose(device: UsbDevice) {
            if (state != "no_device") state = "closed"
            synchronized(ring) { ring.clear() }
        }

        override fun onDeviceClose(device: UsbDevice) {
            selecting = null
        }

        override fun onDetach(device: UsbDevice) {
            if (device.deviceName == selecting || findVideoDevice() == null) {
                selecting = null
                synchronized(ring) { ring.clear() }
                state = "no_device"
                width = 0
                height = 0
                streamStartedAt = 0
                restarts = 0
                fallbackLevel = 0
            }
        }

        override fun onCancel(device: UsbDevice) {
            selecting = null
            state = "denied"
        }
    }

    private fun select(device: UsbDevice) {
        val h = helper ?: return
        if (selecting == device.deviceName && (state == "streaming" || state == "opening" || state == "waiting_permission")) return
        selecting = device.deviceName
        deviceName = try {
            device.productName?.trim()?.takeIf { it.isNotEmpty() } ?: "USB webcam"
        } catch (e: Exception) {
            "USB webcam"
        }
        state = if (usbManager.hasPermission(device)) "opening" else "waiting_permission"
        try {
            h.selectDevice(device)
        } catch (e: Exception) {
            fail("Could not select the webcam", e)
        }
    }

    /** Video modes to try, best first: MJPEG up to the chosen height, then smaller MJPEG, then raw YUYV. */
    private fun candidates(sizes: List<Size>): List<Size> {
        val maxH = prefs.getInt("maxHeight", 1080)
        val area = { s: Size -> s.width * s.height }
        val mjpeg = sizes.filter { it.type == UVCCamera.FRAME_FORMAT_MJPEG }
        val other = sizes.filter { it.type != UVCCamera.FRAME_FORMAT_MJPEG }
        val ordered = ArrayList<Size>()
        ordered += mjpeg.filter { it.height <= maxH }.sortedByDescending(area)
        ordered += other.filter { it.height <= 480 }.sortedByDescending(area) // raw video only works at low res over USB 2.0
        ordered += mjpeg.filter { it.height > maxH }.sortedBy(area)
        if (ordered.isEmpty()) ordered += sizes.sortedBy(area)
        // keep one entry per resolution+format
        return ordered.distinctBy { Triple(it.type, it.width, it.height) }
    }

    private fun startStreaming() {
        val h = helper ?: return
        try {
            val sizes = h.supportedSizeList ?: emptyList()
            frameSizes = sizes.map { Pair(it.width, it.height) }.distinct()
            val list = candidates(sizes)
            if (list.isNotEmpty()) {
                val chosen = list[minOf(fallbackLevel, list.size - 1)]
                try {
                    h.previewSize = chosen
                } catch (e: Exception) {
                    Log.w(TAG, "Mode ${chosen.width}x${chosen.height} rejected", e)
                    fallbackLevel++
                    val next = list.getOrNull(minOf(fallbackLevel, list.size - 1))
                    if (next != null && next !== chosen) {
                        try { h.previewSize = next } catch (e2: Exception) { Log.w(TAG, "Fallback mode rejected", e2) }
                    }
                }
            }
            val actual = h.previewSize
            width = actual?.width ?: 640
            height = actual?.height ?: 480
            h.setFrameCallback(frameCallback, UVCCamera.PIXEL_FORMAT_NV21)
            h.startPreview()
            streamStartedAt = System.currentTimeMillis()
            state = "opening" // becomes "streaming" when the first frame arrives
            message = ""
        } catch (e: Exception) {
            fail("Could not start the video stream", e)
            streamStartedAt = System.currentTimeMillis() // let the watchdog retry with a safer mode
            state = "opening"
        }
    }

    private val frameCallback = IFrameCallback { frame ->
        if (frame == null) return@IFrameCallback
        val now = System.currentTimeMillis()
        if (now - lastFrameAt < FRAME_INTERVAL_MS) return@IFrameCallback
        val buf = frame.duplicate()
        val bytes = buf.remaining()
        var w = width
        var h = height
        if (bytes != w * h * 3 / 2) {
            // Frame size differs from what we asked for: work it out from the buffer length.
            val match = frameSizes.firstOrNull { it.first * it.second * 3 / 2 == bytes } ?: return@IFrameCallback
            w = match.first
            h = match.second
            width = w
            height = h
        }
        synchronized(ring) {
            val data = spare.pollFirst()?.takeIf { it.size == bytes } ?: ByteArray(bytes)
            buf.get(data)
            ring.addLast(Frame(data, w, h, now))
            while (ring.size > RING_SIZE) spare.addLast(ring.pollFirst().nv21)
            while (spare.size > 2) spare.pollFirst()
        }
        lastFrameAt = now
        restarts = 0
        if (state != "streaming") state = "streaming"
    }

    // ------------------------------------------------------------------ frame serving

    private fun serve(path: String): WebResourceResponse? {
        val still = when {
            path.startsWith("frame") -> false
            path.startsWith("still") -> true
            else -> return null
        }
        val f: Frame
        val bytes: ByteArray
        synchronized(ring) {
            val now = System.currentTimeMillis()
            val recent = ring.filter { now - it.time < 1600 }
            val pick = (if (still && recent.size > 1) recent.maxByOrNull { sharpness(it) } else ring.peekLast())
                ?: return unavailable()
            if (now - pick.time > 3000) return unavailable()
            f = pick
            bytes = pick.nv21.copyOf() // copy so the camera thread can recycle the buffer
        }
        return try {
            val out = ByteArrayOutputStream(f.w * f.h / 4)
            YuvImage(bytes, ImageFormat.NV21, f.w, f.h, null).compressToJpeg(Rect(0, 0, f.w, f.h), if (still) 93 else 60, out)
            WebResourceResponse(
                "image/jpeg", null, 200, "OK",
                mapOf("Cache-Control" to "no-store"),
                ByteArrayInputStream(out.toByteArray())
            )
        } catch (e: Exception) {
            Log.w(TAG, "JPEG encode failed", e)
            unavailable()
        }
    }

    /** Variance-of-Laplacian focus measure on the luma plane (sampled), higher = sharper text. */
    private fun sharpness(f: Frame): Double {
        val y = f.nv21
        val w = f.w
        val x0 = w / 10
        val x1 = w - w / 10
        val y0 = f.h / 10
        val y1 = f.h - f.h / 10
        var sum = 0.0
        var sumSq = 0.0
        var n = 0
        var r = y0
        while (r < y1) {
            val row = r * w
            var c = x0
            while (c < x1) {
                val i = row + c
                val lap = 4 * (y[i].toInt() and 0xFF) -
                    (y[i - 1].toInt() and 0xFF) - (y[i + 1].toInt() and 0xFF) -
                    (y[i - w].toInt() and 0xFF) - (y[i + w].toInt() and 0xFF)
                sum += lap
                sumSq += lap.toDouble() * lap
                n++
                c += 3
            }
            r += 3
        }
        if (n == 0) return 0.0
        val mean = sum / n
        return sumSq / n - mean * mean
    }

    private fun unavailable() = WebResourceResponse(
        "text/plain", "utf-8", 503, "No frame",
        mapOf("Cache-Control" to "no-store"),
        ByteArrayInputStream(ByteArray(0))
    )

    // ------------------------------------------------------------------ helpers

    private fun fail(msg: String, e: Exception) {
        Log.e(TAG, msg, e)
        state = "error"
        message = msg
        selecting = null
    }

    private fun hasCameraPermission() =
        activity.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    private fun findVideoDevice(): UsbDevice? =
        usbManager.deviceList.values.firstOrNull { isVideoDevice(it) }

    private fun isVideoDevice(d: UsbDevice): Boolean {
        if (d.deviceClass == UsbConstants.USB_CLASS_VIDEO) return true
        for (i in 0 until d.interfaceCount) {
            if (d.getInterface(i).interfaceClass == UsbConstants.USB_CLASS_VIDEO) return true
        }
        return false
    }

    companion object {
        private const val TAG = "StepCamUsb"
        private const val RING_SIZE = 8
        private const val FRAME_INTERVAL_MS = 150L
        private const val WATCHDOG_MS = 2000L
        private const val STALL_MS = 6000L
        private const val MAX_RESTARTS = 6
    }
}
