package com.stepcam.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.hardware.usb.UsbManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.MediaStore
import android.util.Base64
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.content.FileProvider
import androidx.webkit.WebViewAssetLoader
import java.io.File

/**
 * StepCam: a full-screen WebView running the solver UI from app assets, plus a USB webcam driver.
 * Everything runs on the phone; it only needs the phone's own Wi-Fi/data to reach the AI provider.
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

        /**
         * Sends the problem picture + a ready-made prompt to ChatGPT, Claude or Gemini.
         * Returns "app" (opened the installed app), "chooser" (Android share sheet),
         * "web" (app not installed: picture saved to Photos, prompt copied, website opened) or "error".
         */
        @JavascriptInterface
        fun shareToApp(target: String, base64: String, text: String): String {
            return try {
                val bytes = Base64.decode(base64, Base64.DEFAULT)
                val dir = File(cacheDir, "shared").apply { mkdirs() }
                val file = File(dir, "stepcam-problem.jpg")
                file.writeBytes(bytes)
                val uri = FileProvider.getUriForFile(this@MainActivity, "$packageName.fileprovider", file)
                copy(text) // so the prompt can be pasted if an app ignores the shared text

                val send = Intent(Intent.ACTION_SEND).apply {
                    type = "image/jpeg"
                    putExtra(Intent.EXTRA_STREAM, uri)
                    putExtra(Intent.EXTRA_TEXT, text)
                    clipData = ClipData.newRawUri("StepCam problem", uri)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                }
                val pkg = CHAT_APPS[target]
                if (pkg != null) {
                    val direct = Intent(send).setPackage(pkg)
                    if (direct.resolveActivity(packageManager) != null) {
                        runOnUiThread { startActivity(direct) }
                        return "app"
                    }
                    // App not installed: save the picture and open the website instead.
                    saveToPhotos(bytes)
                    val url = CHAT_SITES[target] ?: return "error"
                    runOnUiThread {
                        try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (_: ActivityNotFoundException) {}
                    }
                    return "web"
                }
                runOnUiThread { startActivity(Intent.createChooser(send, "Send the problem to…")) }
                "chooser"
            } catch (e: Exception) {
                android.util.Log.e("StepCam", "share failed", e)
                "error"
            }
        }
    }

    private fun saveToPhotos(bytes: ByteArray): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return false
        return try {
            val values = ContentValues().apply {
                put(MediaStore.Images.Media.DISPLAY_NAME, "stepcam-" + System.currentTimeMillis() + ".jpg")
                put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
                put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/StepCam")
            }
            val uri = contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: return false
            contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
            true
        } catch (e: Exception) {
            false
        }
    }

    companion object {
        private const val APP_HOST = "appassets.androidplatform.net"
        private const val REQ_CAMERA = 41
        private const val REQ_FILE = 42
        private val CHAT_APPS = mapOf(
            "chatgpt" to "com.openai.chatgpt",
            "claude" to "com.anthropic.claude",
            "gemini" to "com.google.android.apps.bard",
        )
        private val CHAT_SITES = mapOf(
            "chatgpt" to "https://chatgpt.com/",
            "claude" to "https://claude.ai/new",
            "gemini" to "https://gemini.google.com/app",
        )
    }
}
