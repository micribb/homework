package com.stepcam.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.hardware.usb.UsbManager
import android.net.Uri
import android.os.Bundle
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader

/**
 * StepCam: a full-screen WebView running the solver UI from app assets, plus a USB webcam driver.
 * Everything runs on the phone; it only needs the phone's own Wi-Fi/data to reach the Claude API.
 */
class MainActivity : Activity() {

    private lateinit var web: WebView
    private lateinit var usbCam: UsbCam
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingWebPermission: PermissionRequest? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        usbCam = UsbCam(this)
        web = WebView(this)
        web.setBackgroundColor(0xFF0B1017.toInt())
        setContentView(web)

        if ((applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .addPathHandler("/usbcam/", usbCam.pathHandler)
            .build()

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            allowContentAccess = true
            setSupportZoom(false)
            builtInZoomControls = false
            textZoom = 100
        }
        web.addJavascriptInterface(Bridge(), "StepCamNative")

        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == APP_HOST) return false
                // Any other link opens in the phone's browser.
                try {
                    startActivity(Intent(Intent.ACTION_VIEW, request.url))
                } catch (_: ActivityNotFoundException) {
                }
                return true
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    val wantsCamera = request.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE)
                    if (!wantsCamera) {
                        request.deny()
                    } else if (hasCameraPermission()) {
                        request.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE))
                    } else {
                        pendingWebPermission?.deny()
                        pendingWebPermission = request
                        requestCameraPermission()
                    }
                }
            }

            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = filePathCallback
                val pick = Intent(Intent.ACTION_GET_CONTENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE)
                    type = "image/*"
                }
                return try {
                    startActivityForResult(Intent.createChooser(pick, "Choose a picture"), REQ_FILE)
                    true
                } catch (_: ActivityNotFoundException) {
                    fileCallback = null
                    false
                }
            }
        }

        web.loadUrl("https://$APP_HOST/assets/web/index.html")

        if (!hasCameraPermission()) requestCameraPermission()
        if (isUsbAttach(intent)) usbCam.connect()
    }

    override fun onStart() {
        super.onStart()
        if (hasCameraPermission()) usbCam.start()
    }

    override fun onResume() {
        super.onResume()
        web.onResume()
    }

    override fun onPause() {
        web.onPause()
        super.onPause()
    }

    override fun onStop() {
        usbCam.stop()
        super.onStop()
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (isUsbAttach(intent)) {
            usbCam.connect()
            web.evaluateJavascript("window.stepcamUsbAttached && window.stepcamUsbAttached()", null)
        }
    }

    @Deprecated("Uses the platform back callback")
    override fun onBackPressed() {
        web.evaluateJavascript("window.stepcamBack ? window.stepcamBack() : false") { handled ->
            if (handled != "true") finish()
        }
    }

    // ------------------------------------------------------------------ permissions

    fun requestCameraPermission() {
        if (!hasCameraPermission()) requestPermissions(arrayOf(Manifest.permission.CAMERA), REQ_CAMERA)
    }

    private fun hasCameraPermission() =
        checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_CAMERA) return
        val granted = grantResults.isNotEmpty() && grantResults[0] == PackageManager.PERMISSION_GRANTED
        pendingWebPermission?.let {
            if (granted) it.grant(arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE)) else it.deny()
        }
        pendingWebPermission = null
        if (granted) {
            usbCam.start()
            usbCam.connect()
        }
    }

    @Deprecated("Uses the platform activity-result callback")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQ_FILE) {
            fileCallback?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data))
            fileCallback = null
        }
    }

    private fun isUsbAttach(i: Intent?) = i?.action == UsbManager.ACTION_USB_DEVICE_ATTACHED

    // ------------------------------------------------------------------ JS bridge

    inner class Bridge {
        @JavascriptInterface
        fun status(): String = usbCam.statusJson()

        @JavascriptInterface
        fun connect() = usbCam.connect()

        @JavascriptInterface
        fun setResolution(maxHeight: Int) = usbCam.setResolution(maxHeight)

        @JavascriptInterface
        fun copy(text: String) {
            runOnUiThread {
                val cm = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cm.setPrimaryClip(ClipData.newPlainText("StepCam answer", text))
            }
        }
    }

    companion object {
        private const val APP_HOST = "appassets.androidplatform.net"
        private const val REQ_CAMERA = 41
        private const val REQ_FILE = 42
    }
}
