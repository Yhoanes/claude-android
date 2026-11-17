package com.cc.ide.ui.webview;

import android.content.Context;
import android.os.Build;
import android.util.Log;
import android.webkit.CookieManager;
import android.webkit.WebView;

import com.cc.ide.bridge.AndroidBridge;
import com.cc.ide.core.CoreReadyProbe;
import com.cc.ide.core.CoreRuntimeState;
import com.cc.ide.runtime.RuntimePaths;
import com.cc.ide.theme.ThemeManager;

import java.io.File;

/**
 * Loads the local Claude Code Agentic Host loopback origin (`http://127.0.0.1:<port>/?theme=...`)
 * so the official Anthropic Claude Code webview, WebSocket (`/ws`), and PTY (`/pty`) connect cleanly.
 */
public final class AppLoader {

    private static final String TAG = "CC_WebView";

    private AppLoader() {
    }

    public static void load(Context context, WebView webView, ThemeManager theme,
                            AndroidBridge bridge) {
        int port = bridge.getEnginePort();
        if (theme != null) {
            theme.applyToWebView(webView);
        }

        try {
            CookieManager cm = CookieManager.getInstance();
            cm.setAcceptCookie(true);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                cm.setAcceptThirdPartyCookies(webView, false);
            }
            // Every fetch / WebSocket from the WebView must prove it is this app.
            String hostToken = CoreRuntimeState.csrfToken;
            if (hostToken != null && !hostToken.isEmpty()) {
                cm.setCookie("http://127.0.0.1:" + port,
                        CoreReadyProbe.HOST_TOKEN_COOKIE + "=" + hostToken
                                + "; Path=/; HttpOnly; SameSite=Strict");
                cm.flush();
            } else {
                Log.w(TAG, "host token not ready; loopback requests will be rejected");
            }
        } catch (Exception e) {
            Log.w(TAG, "cookie setup warning: " + e.getMessage());
        }

        String resolvedTheme = (theme != null) ? theme.getTheme() : "dark";
        if (!"light".equals(resolvedTheme)) {
            resolvedTheme = "dark";
        }

        LocalAssetServer.setHostThemeHint(resolvedTheme);
        bridge.setCoreOriginActive(true);
        try {
            File defaultWs = new RuntimePaths(context).getDefaultWorkspaceDir();
            if (defaultWs != null && !defaultWs.isDirectory()) {
                defaultWs.mkdirs();
            }
        } catch (Exception e) {
            Log.w(TAG, "default workspace mkdirs warning: " + e.getMessage());
        }
        webView.loadUrl("http://127.0.0.1:" + port + "/?theme=" + resolvedTheme);
    }
}
