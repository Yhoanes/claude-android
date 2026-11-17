package com.cc.ide.ui;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.widget.FrameLayout;

import java.util.ArrayList;
import java.util.List;

import com.cc.ide.bridge.AndroidBridge;
import com.cc.ide.core.CoreRuntimeState;
import com.cc.ide.core.CoreServiceLauncher;
import com.cc.ide.oauth.OAuthManager;
import com.cc.ide.runtime.RuntimeManager;
import com.cc.ide.shell.ShizukuBridge;
import com.cc.ide.theme.ThemeManager;
import com.cc.ide.ui.lifecycle.AppLifecycle;
import com.cc.ide.ui.lifecycle.BackNavigator;
import com.cc.ide.ui.lifecycle.ThemeRefresher;
import com.cc.ide.ui.splash.SplashController;
import com.cc.ide.ui.webview.CcWebChromeClient;
import com.cc.ide.ui.webview.DesktopModePrefs;
import com.cc.ide.ui.webview.WebViewHost;
import com.cc.ide.util.ViewParams;

/**
 * Activity host: builds the WebView, starts CoreServerService, shows the
 * three-dot splash until the core UI has rendered, and wires theming/OAuth.
 * All logic lives in the helper classes; this only wires them and polls.
 */
public class MainActivity extends Activity
        implements WebViewHost.Listener, CcWebChromeClient.FileChooserCallback {

    private static final String TAG = "MainActivity";
    public static final String EXTRA_APPLY_OTA_UPDATE = "com.cc.ide.extra.APPLY_OTA_UPDATE";
    private static final int REQUEST_STORAGE = 100;
    private static final int REQUEST_FILE_CHOOSER = 1002;
    private static final int REQUEST_AUDIO_PERMISSION = 1003;
    private static final int REQUEST_DIRECTORY_PICKER = 1004;
    private static final int REQUEST_STARTUP_PERMISSIONS = 1005;
    private static final long SPLASH_TIMEOUT_MS = 45000;
    private static final long POLL_BOOT_MS = 100;
    private static final long POLL_IDLE_MS = 1500;

    public static volatile MainActivity activeActivity;

    private ValueCallback<Uri[]> filePathCallback;
    private android.webkit.PermissionRequest pendingWebPermissionRequest;
    private String pendingDirectoryJsCallbackId;
    private boolean startupPermissionsRequested = false;
    private final Runnable startupPermRunnable = this::requestStartupRuntimePermissionsIfNeeded;

    private ThemeManager themeManager;
    private OAuthManager oauthManager;
    private RuntimeManager runtimeManager;
    private ShizukuBridge shizukuBridge;
    private AndroidBridge androidBridge;
    private WebViewHost webViewHost;
    private SplashController splash;
    private FrameLayout rootLayout;

    private boolean appLoaded = false;
    private int loadedGeneration = -1;
    private long splashDeadline;

    private final Handler handler = new Handler(Looper.getMainLooper());

    /**
     * Drives the splash, loads the app on ready, and watches for a post-ready core restart.
     * Paused automatically when the Activity is in the background so it costs zero CPU/battery.
     */
    private final Runnable pollServer = new Runnable() {
        @Override
        public void run() {
            watchCore();
            handler.postDelayed(this, appLoaded ? POLL_IDLE_MS : POLL_BOOT_MS);
        }
    };

    private void watchCore() {
        String error = CoreRuntimeState.lastError;
        if (error != null) {
            if (CoreRuntimeState.restarting) {
                splash.showTransient(error);
            } else {
                splash.showFatalError(error);
            }
            return;
        }
        if (CoreRuntimeState.serverUrl != null && webViewHost != null) {
            int generation = CoreRuntimeState.readyGeneration;
            if (!appLoaded || (loadedGeneration > 0 && generation != loadedGeneration)) {
                appLoaded = true;
                loadedGeneration = generation;
                splash.clearFatal();
                if (generation > 1) {
                    splash.showLoading();
                }
                webViewHost.loadApp();
                handler.postDelayed(new Runnable() {
                    @Override
                    public void run() {
                        if (appLoaded && !splash.isFatalShown()) {
                            Log.w(TAG, "watchdog: auto-dismissing splash after timeout");
                            dismissSplash();
                        }
                    }
                }, 10000);
            }
            return;
        }
        if (CoreRuntimeState.serverUrl == null && !splash.isFatalShown()
                && System.currentTimeMillis() > splashDeadline) {
            splash.showFatalError("core did not start within " + (SPLASH_TIMEOUT_MS / 1000) + "s");
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        activeActivity = this;
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);

        themeManager = new ThemeManager(this);
        themeManager.applyToActivity(this);


        oauthManager = new OAuthManager();
        runtimeManager = new RuntimeManager(this);
        shizukuBridge = new ShizukuBridge(this);
        androidBridge = new AndroidBridge(this, runtimeManager, shizukuBridge, oauthManager, themeManager);
        androidBridge.setActivity(this);
        webViewHost = new WebViewHost(this, themeManager, oauthManager, androidBridge, this);
        webViewHost.setListener(this);
        com.cc.ide.update.AppUpdateManager.getInstance(this).attachWebView(webViewHost.getWebView());

        rootLayout = new FrameLayout(this);
        rootLayout.setBackgroundColor(themeManager.getBackgroundColor());
        setContentView(rootLayout);

        rootLayout.addView(webViewHost.getWebView(), ViewParams.full());

        splash = new SplashController(this, themeManager, rootLayout);
        splash.setRetryListener(this::retryCore);
        rootLayout.addView(splash.view(), ViewParams.full());
        splash.loadInitial();

        splash.installExitAnimation(this);

        splashDeadline = System.currentTimeMillis() + SPLASH_TIMEOUT_MS;
        requestStoragePermissions();
        startCoreService();

        handler.postDelayed(pollServer, 30);
        handleUpdateNotificationIntent(getIntent());
    }

    private void startCoreService() {
        try {
            CoreServiceLauncher.start(this);
        } catch (Exception e) {
            showFatalError("cannot start core service: "
                    + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()));
        }
    }

    /** Keep the splash visible and replace it with a readable failure message. */
    public void showFatalError(String message) {
        splash.showFatalError(message);
    }

    /** Retry re-runs install + start: stop the service, then start it again. */
    private void retryCore() {
        splash.clearFatal();
        appLoaded = false;
        loadedGeneration = -1;
        splashDeadline = System.currentTimeMillis() + SPLASH_TIMEOUT_MS;
        splash.showLoading();
        CoreServiceLauncher.stop(this);
        try {
            java.io.File marker = new java.io.File(runtimeManager.getRuntimeDir(), com.cc.ide.runtime.RuntimePaths.RUNTIME_MARKER);
            if (marker.exists()) {
                marker.delete();
            }
        } catch (Exception ignored) {
        }
        handler.postDelayed(this::startCoreService, 400);
    }

    /**
     * Page load finished, but the Web UI has NOT necessarily painted yet (the
     * app bundle is large), so the splash is NOT dismissed here. Dismissal is
     * driven by web/patches/startup_ready.js -> AndroidBridge.onUiReady().
     */
    @Override
    public void onPageFinished(String url) {
        Log.i(TAG, "onPageFinished " + url);
        WebView wv = getWebView();
        int port = androidBridge != null ? androidBridge.getEnginePort() : -1;
        if (wv != null && com.cc.ide.util.LoopbackHost.isCoreOriginUrl(url, port)) {
            try {
                java.io.File bootFile = new java.io.File(runtimeManager.getWebDir(), "__cc_android_boot.js");
                if (bootFile.isFile()) {
                    try (java.io.FileInputStream fis = new java.io.FileInputStream(bootFile)) {
                        String bootJs = com.cc.ide.util.IoUtil.readAll(fis, "UTF-8");
                        String tokenInit = "if(!window.__CC_ANDROID_BOOTED__){window.__CC_BRIDGE_TOKEN__="
                                + org.json.JSONObject.quote(androidBridge.getBridgeAuthToken()) + ";\n"
                                + bootJs + "\n}";
                        wv.evaluateJavascript(tokenInit, null);
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "bootJs eval fallback warning: " + e.getMessage());
            }
        }
        com.cc.ide.update.AppUpdateManager.getInstance(this).onWebViewPageFinished(wv);
    }

    public WebView getWebView() {
        return webViewHost != null ? webViewHost.getWebView() : null;
    }

    private void handleUpdateNotificationIntent(Intent intent) {
        if (intent != null && intent.getBooleanExtra(EXTRA_APPLY_OTA_UPDATE, false)) {
            String tok = intent.getStringExtra(com.cc.ide.update.AppUpdateManager.EXTRA_OTA_TOKEN);
            intent.removeExtra(EXTRA_APPLY_OTA_UPDATE);
            intent.removeExtra(com.cc.ide.update.AppUpdateManager.EXTRA_OTA_TOKEN);
            if (com.cc.ide.update.AppUpdateManager.verifyOtaIntentToken(tok)) {
                handler.postDelayed(() -> com.cc.ide.update.AppUpdateManager.getInstance(this).applyUpdate(), 250);
            }
        }
    }

    /** Idempotent; called by AndroidBridge.onUiReady() on the main thread. */
    public void dismissSplash() {
        Log.i(TAG, "dismissSplash: fading out splashView (280ms)");
        splash.dismiss();
    }

    public boolean isDesktopMode() {
        return webViewHost != null ? webViewHost.isDesktopMode() : DesktopModePrefs.isDesktopMode(this);
    }

    public void setDesktopMode(boolean enabled) {
        if (webViewHost != null) {
            webViewHost.setDesktopMode(enabled);
        } else {
            DesktopModePrefs.setDesktopMode(this, enabled);
        }
    }

    @Override
    protected void onDestroy() {
        if (activeActivity == this) {
            activeActivity = null;
        }
        if (pendingWebPermissionRequest != null) {
            try {
                pendingWebPermissionRequest.deny();
            } catch (Throwable ignored) {
            }
            pendingWebPermissionRequest = null;
        }
        if (filePathCallback != null) {
            try {
                filePathCallback.onReceiveValue(null);
            } catch (Throwable ignored) {
            }
            filePathCallback = null;
        }
        WebView wv = getWebView();
        com.cc.ide.update.AppUpdateManager.getInstance(this).detachWebView(wv);
        if (androidBridge != null) {
            androidBridge.setCoreOriginActive(false);
            androidBridge.setActivity(null);
        }
        AppLifecycle.destroy(handler);
        if (webViewHost != null) {
            webViewHost.destroy();
            webViewHost = null;
        }
        super.onDestroy();
    }

    @Override
    public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        AppLifecycle.trimMemory(level, handler, webViewHost);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleUpdateNotificationIntent(intent);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        refreshTheme();
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (webViewHost != null) {
            AppLifecycle.pauseTimers(webViewHost.getWebView());
        }
    }

    @Override
    protected void onStop() {
        super.onStop();
        handler.removeCallbacks(pollServer);
        handler.removeCallbacks(startupPermRunnable);
        com.cc.ide.theme.LauncherIconSwitcher.onAppBackgrounded(this);
        if (webViewHost != null) {
            AppLifecycle.pauseTimers(webViewHost.getWebView());
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        activeActivity = this;
        handler.removeCallbacks(pollServer);
        handler.post(pollServer);
        if (webViewHost != null) {
            AppLifecycle.resume(webViewHost.getWebView());
            com.cc.ide.update.AppUpdateManager.getInstance(this)
                    .onActivityResumed(this, webViewHost.getWebView());
        }
        refreshTheme();
        handler.removeCallbacks(startupPermRunnable);
        handler.postDelayed(startupPermRunnable, 700);
    }

    private void requestStartupRuntimePermissionsIfNeeded() {
        if (startupPermissionsRequested || Build.VERSION.SDK_INT < Build.VERSION_CODES.M) {
            return;
        }
        if (!hasWindowFocus()) {
            return;
        }
        List<String> needed = new ArrayList<>();
        // Microphone is requested on demand only (never at first launch).
        if (Build.VERSION.SDK_INT >= 33) {
            if (checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                    != PackageManager.PERMISSION_GRANTED) {
                needed.add("android.permission.POST_NOTIFICATIONS");
            }
        }
        if (!needed.isEmpty()) {
            startupPermissionsRequested = true;
            try {
                requestPermissions(needed.toArray(new String[0]), REQUEST_STARTUP_PERMISSIONS);
            } catch (Throwable ignored) {
            }
        }
    }

    private void refreshTheme() {
        ThemeRefresher.refresh(this, themeManager, rootLayout, splash, webViewHost);
        if (webViewHost != null && webViewHost.getWebView() != null) {
            String resolved = themeManager != null ? themeManager.getTheme() : "light";
            webViewHost.getWebView().evaluateJavascript(
                    "window.__AG_RESOLVED_THEME__='" + resolved + "'; window.__agOnSystemThemeChanged && window.__agOnSystemThemeChanged();", null);
        }
    }

    @Override
    public void onBackPressed() {
        if (!BackNavigator.handle(webViewHost != null ? webViewHost.getWebView() : null)) {
            super.onBackPressed();
        }
    }

    private void requestStoragePermissions() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                if (!android.os.Environment.isExternalStorageManager()) {
                    Intent intent = new Intent(
                            android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION);
                    intent.setData(Uri.parse("package:" + getPackageName()));
                    startActivity(intent);
                }
            } catch (Exception e) {
                try {
                    startActivity(new Intent(
                            android.provider.Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION));
                } catch (Exception ignored) {
                }
            }
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            if (checkSelfPermission(android.Manifest.permission.READ_EXTERNAL_STORAGE)
                    != PackageManager.PERMISSION_GRANTED
                    || checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE)
                    != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{
                        android.Manifest.permission.READ_EXTERNAL_STORAGE,
                        android.Manifest.permission.WRITE_EXTERNAL_STORAGE
                }, REQUEST_STORAGE);
            }
        }
        requestBatteryOptimizationExemption();
    }

    private void requestBatteryOptimizationExemption() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            try {
                android.os.PowerManager pm =
                        (android.os.PowerManager) getSystemService(POWER_SERVICE);
                String pkg = getPackageName();
                if (pm != null && !pm.isIgnoringBatteryOptimizations(pkg)) {
                    Intent intent = new Intent(
                            android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
                    intent.setData(Uri.parse("package:" + pkg));
                    startActivity(intent);
                }
            } catch (Exception e) {
                Log.w(TAG, "cannot request battery optimization exemption: " + e.getMessage());
            }
        }
    }

    @Override
    public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> callback,
                                      WebChromeClient.FileChooserParams fileChooserParams) {
        if (filePathCallback != null) {
            filePathCallback.onReceiveValue(null);
            filePathCallback = null;
        }
        this.filePathCallback = callback;

        Intent chooserIntent = null;

        // 1. Try standard intent built by Chromium WebChromeClient
        if (fileChooserParams != null) {
            try {
                Intent defaultIntent = fileChooserParams.createIntent();
                if (defaultIntent != null) {
                    chooserIntent = Intent.createChooser(defaultIntent, "Select Media / Files");
                }
            } catch (Throwable t) {
                Log.w(TAG, "fileChooserParams.createIntent failed: " + t.getMessage());
            }
        }

        // 2. Fallback to universal ACTION_GET_CONTENT chooser (supports Gallery, Photos, Files)
        if (chooserIntent == null) {
            Intent contentIntent = new Intent(Intent.ACTION_GET_CONTENT);
            contentIntent.addCategory(Intent.CATEGORY_OPENABLE);
            contentIntent.setType("*/*");
            if (fileChooserParams != null) {
                String[] acceptTypes = fileChooserParams.getAcceptTypes();
                if (acceptTypes != null && acceptTypes.length > 0) {
                    List<String> validMimes = new ArrayList<>();
                    for (String type : acceptTypes) {
                        if (type != null && type.contains("/")) {
                            validMimes.add(type.trim());
                        }
                    }
                    if (!validMimes.isEmpty()) {
                        contentIntent.putExtra(Intent.EXTRA_MIME_TYPES, validMimes.toArray(new String[0]));
                    }
                }
                if (fileChooserParams.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
                    contentIntent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                }
            }
            chooserIntent = Intent.createChooser(contentIntent, "Select Media / Files");
        }

        try {
            startActivityForResult(chooserIntent, REQUEST_FILE_CHOOSER);
            return true;
        } catch (Throwable e) {
            Log.w(TAG, "Chooser failed, fallback to plain GET_CONTENT: " + e.getMessage());
            try {
                Intent fallback = new Intent(Intent.ACTION_GET_CONTENT);
                fallback.addCategory(Intent.CATEGORY_OPENABLE);
                fallback.setType("*/*");
                if (fileChooserParams != null
                        && fileChooserParams.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
                    fallback.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                }
                startActivityForResult(fallback, REQUEST_FILE_CHOOSER);
                return true;
            } catch (Throwable ex) {
                Log.e(TAG, "Cannot launch file chooser: " + ex.getMessage());
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                    filePathCallback = null;
                }
                return false;
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_FILE_CHOOSER) {
            if (filePathCallback != null) {
                Uri[] results = null;
                try {
                    results = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
                } catch (Throwable t) {
                    Log.w(TAG, "parseResult error: " + t.getMessage());
                }
                if (results == null && resultCode == RESULT_OK && data != null) {
                    ClipData clipData = data.getClipData();
                    if (clipData != null && clipData.getItemCount() > 0) {
                        results = new Uri[clipData.getItemCount()];
                        for (int i = 0; i < clipData.getItemCount(); i++) {
                            results[i] = clipData.getItemAt(i).getUri();
                        }
                    } else if (data.getData() != null) {
                        results = new Uri[]{data.getData()};
                    } else if (data.getDataString() != null) {
                        results = new Uri[]{Uri.parse(data.getDataString())};
                    }
                }
                if (results != null) {
                    for (Uri uri : results) {
                        if (uri != null) {
                            try {
                                grantUriPermission(getPackageName(), uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                            } catch (Throwable ignored) {}
                            try {
                                getContentResolver().takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
                            } catch (Throwable ignored) {}
                        }
                    }
                }
                filePathCallback.onReceiveValue(results);
                filePathCallback = null;
            }
            return;
        }
        if (requestCode == REQUEST_DIRECTORY_PICKER) {
            String cbId = this.pendingDirectoryJsCallbackId;
            this.pendingDirectoryJsCallbackId = null;
            String resolvedPath = "";
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                Uri treeUri = data.getData();
                try {
                    int takeFlags = data.getFlags()
                            & (Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                    if (takeFlags == 0) {
                        takeFlags = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
                    }
                    getContentResolver().takePersistableUriPermission(treeUri, takeFlags);
                } catch (Throwable ignored) {
                }
                resolvedPath = resolveDocumentTreeUriToPath(treeUri);
                if (resolvedPath != null && !resolvedPath.isEmpty()) {
                    try {
                        java.io.File dir = new java.io.File(resolvedPath);
                        if (!dir.exists()) {
                            dir.mkdirs();
                        }
                    } catch (Throwable ignored) {
                    }
                }
            }
            resolveDirectoryJsCallback(cbId, resolvedPath != null ? resolvedPath : "");
        }
    }

    public void pickProjectDirectoryFromJs(final String callbackId) {
        handler.post(() -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                    && !android.os.Environment.isExternalStorageManager()) {
                android.widget.Toast.makeText(
                        this,
                        "Activa acceso a archivos para abrir carpetas del dispositivo",
                        android.widget.Toast.LENGTH_LONG).show();
                requestStoragePermissions();
                resolveDirectoryJsCallback(callbackId, "");
                return;
            }
            this.pendingDirectoryJsCallbackId = callbackId;
            try {
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                        | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                        | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
                        | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    try {
                        Uri initialUri = android.provider.DocumentsContract.buildDocumentUri(
                                "com.android.externalstorage.documents", "primary:Documents");
                        intent.putExtra(android.provider.DocumentsContract.EXTRA_INITIAL_URI, initialUri);
                    } catch (Throwable ignored) {
                    }
                }
                startActivityForResult(intent, REQUEST_DIRECTORY_PICKER);
            } catch (Throwable t) {
                Log.e(TAG, "Cannot launch ACTION_OPEN_DOCUMENT_TREE: " + t.getMessage());
                this.pendingDirectoryJsCallbackId = null;
                resolveDirectoryJsCallback(callbackId, "");
            }
        });
    }

    private void resolveDirectoryJsCallback(final String callbackId, final String path) {
        if (webViewHost == null || webViewHost.getWebView() == null) {
            return;
        }
        final String safeId = callbackId == null ? "" : callbackId;
        final String safePath = path == null ? "" : path;
        handler.post(() -> {
            try {
                webViewHost.getWebView().evaluateJavascript(
                        "window.__ccOnDirectoryPicked&&window.__ccOnDirectoryPicked("
                                + org.json.JSONObject.quote(safeId) + ","
                                + org.json.JSONObject.quote(safePath) + ");",
                        null);
            } catch (Throwable ignored) {
            }
        });
    }

    private String resolveDocumentTreeUriToPath(Uri treeUri) {
        if (treeUri == null) {
            return "";
        }
        try {
            if ("file".equalsIgnoreCase(treeUri.getScheme())) {
                return treeUri.getPath() != null ? treeUri.getPath() : "";
            }
            String docId = android.provider.DocumentsContract.getTreeDocumentId(treeUri);
            if (docId == null || docId.isEmpty()) {
                return "";
            }
            if (docId.startsWith("raw:")) {
                return docId.substring(4);
            }
            if (docId.startsWith("/")) {
                return docId;
            }
            String extRoot = android.os.Environment.getExternalStorageDirectory().getAbsolutePath();
            int colon = docId.indexOf(':');
            String volume = colon >= 0 ? docId.substring(0, colon) : docId;
            String rel = colon >= 0 ? docId.substring(colon + 1) : "";
            while (rel.startsWith("/")) {
                rel = rel.substring(1);
            }
            if ("primary".equalsIgnoreCase(volume) || "0".equals(volume)) {
                return rel.isEmpty() ? extRoot : (extRoot + "/" + rel);
            }
            if ("home".equalsIgnoreCase(volume)) {
                String docsRoot = extRoot + "/Documents";
                return rel.isEmpty() ? docsRoot : (docsRoot + "/" + rel);
            }
            java.io.File storageVol = new java.io.File("/storage", volume);
            if (storageVol.exists()) {
                String volPath = storageVol.getAbsolutePath();
                return rel.isEmpty() ? volPath : (volPath + "/" + rel);
            }
            return rel.isEmpty() ? extRoot : (extRoot + "/" + rel);
        } catch (Throwable t) {
            Log.w(TAG, "resolveDocumentTreeUriToPath fallback: " + t.getMessage());
            return "";
        }
    }

    public void requestWebViewAudioPermission(android.webkit.PermissionRequest request) {
        if (this.pendingWebPermissionRequest != null && this.pendingWebPermissionRequest != request) {
            try {
                this.pendingWebPermissionRequest.deny();
            } catch (Throwable ignored) {
            }
        }
        this.pendingWebPermissionRequest = request;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            requestPermissions(new String[]{android.Manifest.permission.RECORD_AUDIO}, REQUEST_AUDIO_PERMISSION);
        } else if (request != null) {
            request.grant(new String[]{android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE});
            this.pendingWebPermissionRequest = null;
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (Build.VERSION.SDK_INT >= 33) {
            if (checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                    == PackageManager.PERMISSION_GRANTED) {
                com.cc.ide.core.CoreServiceLauncher.start(this);
            }
        }
        if (requestCode == com.cc.ide.core.MicBridge.REQUEST_CODE) {
            com.cc.ide.core.MicBridge.onPermissionResult(grantResults != null && grantResults.length > 0
                    && grantResults[0] == PackageManager.PERMISSION_GRANTED);
            return;
        }
        if (requestCode == REQUEST_AUDIO_PERMISSION) {
            boolean granted = false;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                granted = checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
                        == PackageManager.PERMISSION_GRANTED;
            } else if (grantResults != null && grantResults.length > 0) {
                granted = grantResults[0] == PackageManager.PERMISSION_GRANTED;
            }
            android.webkit.PermissionRequest req = this.pendingWebPermissionRequest;
            this.pendingWebPermissionRequest = null;
            if (req != null) {
                try {
                    if (granted) {
                        req.grant(new String[]{android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                    } else {
                        req.deny();
                    }
                } catch (Throwable ignored) {
                }
            }
            return;
        }
        if (requestCode == com.cc.ide.ui.download.FileDownloader.REQUEST_STORAGE_DOWNLOAD) {
            WebView wv = (webViewHost != null) ? webViewHost.getWebView() : null;
            com.cc.ide.ui.download.FileDownloader.onPermissionResult(this, wv, requestCode, grantResults);
        }
    }
}
