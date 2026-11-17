package com.cc.ide.bridge;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import com.cc.ide.oauth.OAuthManager;
import com.cc.ide.runtime.RuntimeConfig;
import com.cc.ide.runtime.RuntimeManager;
import com.cc.ide.shell.ShizukuBridge;
import com.cc.ide.theme.ThemeManager;
import com.cc.ide.ui.MainActivity;
import com.cc.ide.ui.download.FileDownloader;
import com.cc.ide.update.AppUpdateManager;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;

/**
 * Capability-hardened JS bridge exposed to the WebView as {@code window.Android}.
 *
 * Security model:
 *  - Unauthenticated shell/password methods ({@code exec}, {@code shizuku}, {@code getCsrfToken})
 *    are NEVER exposed via {@code @JavascriptInterface}.
 *  - Every method requires {@code coreOriginActive == true} (verified by {@code CcWebViewClient}).
 *  - Privileged plugin, config, OTA install, and directory actions additionally require a
 *    per-instance 256-bit capability token ({@code bridgeAuthToken}) captured inside
 *    {@code __cc_android_boot.js}'s private closure and deleted from {@code window} immediately.
 *  - Heavy plugin operations run asynchronously on background worker threads so {@code JavaBridge}
 *    never stalls UI messages.
 */
public final class AndroidBridge {

    private final Context appContext;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final UiBridge ui = new UiBridge();
    private final ThemeBridge themeBridge;
    private final EngineBridge engine;
    private final ExternalUrlBridge external;
    private final NotificationBridge notification;
    private final String bridgeAuthToken;
    private final String rawInterfaceName;
    private volatile boolean coreOriginActive = false;

    public AndroidBridge(Context context, RuntimeManager runtime,
                         ShizukuBridge shizuku, OAuthManager oauth,
                         ThemeManager theme) {
        Context appContext = context.getApplicationContext();
        this.appContext = appContext;
        this.themeBridge = new ThemeBridge(theme);
        this.engine = new EngineBridge(runtime);
        this.external = new ExternalUrlBridge(appContext, oauth);
        this.notification = new NotificationBridge(appContext, shizuku);
        this.bridgeAuthToken = generateCapabilityToken();
        this.rawInterfaceName = generateRandomBindingName();
    }

    private static String generateCapabilityToken() {
        byte[] raw = new byte[32];
        new SecureRandom().nextBytes(raw);
        StringBuilder sb = new StringBuilder(64);
        for (byte b : raw) {
            sb.append(String.format("%02x", b & 0xff));
        }
        return sb.toString();
    }

    private static String generateRandomBindingName() {
        byte[] raw = new byte[8];
        new SecureRandom().nextBytes(raw);
        StringBuilder sb = new StringBuilder("__cc_nb_");
        for (byte b : raw) {
            sb.append(String.format("%02x", b & 0xff));
        }
        return sb.toString();
    }

    /** Java-only accessor (never exposed to JS). */
    public String getBridgeAuthToken() {
        return bridgeAuthToken;
    }

    /** Java-only accessor (never exposed to JS). */
    public String getRawInterfaceName() {
        return rawInterfaceName;
    }

    /** Java-only accessor (never exposed to JS). */
    public void setCoreOriginActive(boolean active) {
        this.coreOriginActive = active;
    }

    /** Java-only accessor (never exposed to JS). */
    public boolean isCoreOriginActive() {
        return coreOriginActive;
    }

    private boolean isAuthorized(String token) {
        if (!coreOriginActive || token == null || token.length() != bridgeAuthToken.length()) {
            return false;
        }
        return MessageDigest.isEqual(
                token.getBytes(StandardCharsets.UTF_8),
                bridgeAuthToken.getBytes(StandardCharsets.UTF_8));
    }

    public void setActivity(MainActivity activity) {
        ui.setActivity(activity);
    }

    @JavascriptInterface
    public void onUiReady() {
        if (!coreOriginActive) return;
        ui.onUiReady();
    }

    @JavascriptInterface
    public void onUiError(final String errorMessage) {
        if (!coreOriginActive) return;
        ui.onUiError(errorMessage);
    }

    @JavascriptInterface
    public boolean setTheme(String mode) {
        if (!coreOriginActive) return false;
        return themeBridge.setTheme(mode);
    }

    @JavascriptInterface
    public boolean setThemeByUser(final String mode) {
        if (!coreOriginActive) return false;
        return themeBridge.setThemeByUser(mode);
    }

    @JavascriptInterface
    public void onVisualThemeChanged(String visual) {
        if (!coreOriginActive) return;
        themeBridge.onVisualThemeChanged(visual);
    }

    @JavascriptInterface
    public String getTheme() {
        if (!coreOriginActive) return "system";
        return themeBridge.getTheme();
    }

    @JavascriptInterface
    public boolean isDesktopMode() {
        if (!coreOriginActive) return false;
        return ui.isDesktopMode();
    }

    @JavascriptInterface
    public void setDesktopMode(boolean enabled) {
        if (!coreOriginActive) return;
        ui.setDesktopMode(enabled);
    }

    public int getEnginePort() {
        return engine.getPort();
    }

    public String getEngineBaseUrl() {
        return engine.getBaseUrl();
    }

    @JavascriptInterface
    public void openUrl(String url) {
        if (!coreOriginActive) return;
        external.open(url);
    }

    /** Encrypts the API key with the Android Keystore; it is never stored in plaintext. */
    @JavascriptInterface
    public boolean storeApiKeyAuth(String authToken, String apiKey) {
        if (!isAuthorized(authToken)) return false;
        return com.cc.ide.security.SecretStore.saveApiKey(appContext, apiKey);
    }

    @JavascriptInterface
    public boolean clearApiKeyAuth(String authToken) {
        if (!isAuthorized(authToken)) return false;
        com.cc.ide.security.SecretStore.clearApiKey(appContext);
        return true;
    }

    @JavascriptInterface
    public boolean postNotification(String title, String message, String tag) {
        if (!coreOriginActive) return false;
        return notification.post(title, message, tag);
    }

    @JavascriptInterface
    public void saveBlob(String base64Data, String filename, String mimeType) {
        if (!coreOriginActive) return;
        if (MainActivity.activeActivity != null) {
            FileDownloader.handleBlobData(
                    MainActivity.activeActivity, base64Data, filename, mimeType);
        }
    }

    @JavascriptInterface
    public String getPluginsCatalogJson() {
        if (!coreOriginActive) return "{\"plugins\":[]}";
        return engine.getPluginsCatalogJson();
    }

    @JavascriptInterface
    public String listAndroidPluginsAuth(String authToken) {
        if (!isAuthorized(authToken)) {
            return "{}";
        }
        return engine.listAndroidPlugins();
    }

    private void emitPluginCallback(final String callbackId, final String resultJson) {
        if (callbackId == null || callbackId.isEmpty()) {
            return;
        }
        final String safeCb = org.json.JSONObject.quote(callbackId);
        final String safeRes = org.json.JSONObject.quote(resultJson != null ? resultJson : "{}");
        mainHandler.post(() -> {
            MainActivity act = MainActivity.activeActivity;
            WebView wv = act != null ? act.getWebView() : null;
            if (wv != null) {
                try {
                    wv.evaluateJavascript(
                            "window.__ccOnPluginOpDone&&window.__ccOnPluginOpDone("
                                    + safeCb + "," + safeRes + ");",
                            null);
                } catch (Throwable ignored) {
                }
            }
        });
    }

    @JavascriptInterface
    public void installMarketplacePluginAsync(final String authToken,
                                              final String callbackId,
                                              final String pluginName,
                                              final String archiveUrl,
                                              final String catalogId,
                                              final String marketplace,
                                              final String version) {
        if (!isAuthorized(authToken)) {
            emitPluginCallback(callbackId, "{\"ok\":false,\"error\":\"Unauthorized bridge request\"}");
            return;
        }
        Thread worker = new Thread(() -> {
            String raw = engine.installMarketplacePlugin(pluginName, archiveUrl, catalogId, marketplace, version);
            emitPluginCallback(callbackId, raw);
        }, "OcPluginInstall");
        worker.setDaemon(true);
        worker.start();
    }

    @JavascriptInterface
    public void toggleAndroidPluginAsync(final String authToken,
                                         final String callbackId,
                                         final String pluginName,
                                         final boolean enabled) {
        if (!isAuthorized(authToken)) {
            emitPluginCallback(callbackId, "{\"ok\":false,\"error\":\"Unauthorized bridge request\"}");
            return;
        }
        Thread worker = new Thread(() -> {
            String raw = engine.toggleAndroidPlugin(pluginName, enabled);
            emitPluginCallback(callbackId, raw);
        }, "OcPluginToggle");
        worker.setDaemon(true);
        worker.start();
    }

    @JavascriptInterface
    public void uninstallMarketplacePluginAsync(final String authToken,
                                                final String callbackId,
                                                final String pluginName) {
        if (!isAuthorized(authToken)) {
            emitPluginCallback(callbackId, "{\"ok\":false,\"error\":\"Unauthorized bridge request\"}");
            return;
        }
        Thread worker = new Thread(() -> {
            boolean ok = engine.uninstallMarketplacePlugin(pluginName);
            emitPluginCallback(callbackId, "{\"ok\":" + ok + "}");
        }, "OcPluginUninstall");
        worker.setDaemon(true);
        worker.start();
    }

    @JavascriptInterface
    public String getAppVersion() {
        if (!coreOriginActive) return RuntimeConfig.CORE_VERSION;
        try {
            return AppUpdateManager.getInstance(appContext).getInstalledVersion();
        } catch (Throwable t) {
            return RuntimeConfig.CORE_VERSION;
        }
    }

    @JavascriptInterface
    public String getUpdateStateJson() {
        if (!coreOriginActive) return "{\"type\":\"idle\"}";
        try {
            return AppUpdateManager.getInstance(appContext).getStateJson();
        } catch (Throwable t) {
            return "{\"type\":\"idle\"}";
        }
    }

    @JavascriptInterface
    public void checkForAppUpdates(boolean manual) {
        if (!coreOriginActive) return;
        try {
            AppUpdateManager.getInstance(appContext).checkForUpdates(manual);
        } catch (Throwable ignored) {
        }
    }

    @JavascriptInterface
    public void applyAppUpdateAuth(String authToken) {
        if (!isAuthorized(authToken)) return;
        try {
            AppUpdateManager.getInstance(appContext).applyUpdate();
        } catch (Throwable ignored) {
        }
    }

    @JavascriptInterface
    public void pickProjectDirectoryAuth(final String authToken, final String callbackId) {
        if (!isAuthorized(authToken)) {
            return;
        }
        MainActivity act = MainActivity.activeActivity;
        if (act != null) {
            act.pickProjectDirectoryFromJs(callbackId);
        }
    }
}
