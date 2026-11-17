package com.cc.ide.ui.webview;

import android.content.Context;
import android.graphics.Bitmap;
import android.os.Message;
import android.util.Log;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import com.cc.ide.oauth.OAuthManager;

/**
 * Handles {@code window.open}: captures the target URL in a transient, scriptless
 * WebView, forwards it to the system browser / Chrome Custom Tab, and immediately
 * destroys the temporary WebView so it never leaks memory.
 */
public final class PopupWindowHandler {

    private static final String TAG = "CC_WebView";

    private final Context context;
    private final OAuthManager oauth;

    public PopupWindowHandler(Context context, OAuthManager oauth) {
        this.context = context;
        this.oauth = oauth;
    }

    private void handoffAndDestroy(final WebView popup, String url) {
        if (url != null && !url.isEmpty() && !"about:blank".equals(url)) {
            Log.i(TAG, "popup -> external browser: " + com.cc.ide.util.CoreUrl.stripUrlSecrets(url));
            oauth.openInBrowser(context, url);
        }
        if (popup != null) {
            popup.post(() -> {
                try {
                    popup.stopLoading();
                    popup.destroy();
                } catch (Throwable ignored) {
                }
            });
        }
    }

    public boolean handle(WebView parent, boolean isDialog, boolean isUserGesture,
                          Message resultMsg) {
        WebView popup = new WebView(context);
        WebSettings ws = popup.getSettings();
        ws.setJavaScriptEnabled(false);
        ws.setAllowFileAccess(false);
        ws.setAllowContentAccess(false);
        popup.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, android.webkit.WebResourceRequest request) {
                String url = request != null && request.getUrl() != null
                        ? request.getUrl().toString() : null;
                if (url != null && !url.isEmpty() && !"about:blank".equals(url)) {
                    handoffAndDestroy(v, url);
                    return true;
                }
                return false;
            }

            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView v, String url) {
                if (url != null && !url.isEmpty() && !"about:blank".equals(url)) {
                    handoffAndDestroy(v, url);
                    return true;
                }
                return false;
            }

            @Override
            public void onPageStarted(WebView v, String url, Bitmap favicon) {
                if (url != null && !url.isEmpty() && !"about:blank".equals(url)) {
                    handoffAndDestroy(v, url);
                }
            }
        });
        if (resultMsg != null && resultMsg.obj instanceof WebView.WebViewTransport) {
            ((WebView.WebViewTransport) resultMsg.obj).setWebView(popup);
            resultMsg.sendToTarget();
        } else {
            popup.destroy();
        }
        return true;
    }
}
