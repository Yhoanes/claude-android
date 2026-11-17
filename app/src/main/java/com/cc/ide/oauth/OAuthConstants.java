package com.cc.ide.oauth;

/** OAuth/Custom-Tab constants for Claude Code Android (no androidx.browser dependency). */
public final class OAuthConstants {

    public static final String TAG = "CC_OAuth";

    public static final String CHROME_PACKAGE = "com.android.chrome";

    public static final String EXTRA_SESSION = "android.support.customtabs.extra.SESSION";
    public static final String EXTRA_TOOLBAR_COLOR =
            "android.support.customtabs.extra.TOOLBAR_COLOR";
    public static final String EXTRA_APP_ID = "com.android.browser.application_id";
    public static final int TOOLBAR_COLOR_DARK = 0xFF141413;

    private OAuthConstants() {
    }
}
