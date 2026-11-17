package com.cc.ide.shell;

import android.content.Context;

import java.io.File;

/**
 * Locates the active `rish` binary when the user has installed and enabled
 * the `agy-adb-bridge` plugin from Settings → Plugins.
 */
public final class RishLocator {

    /** Bundled Shizuku fallback kept off PATH unless `agy-adb-bridge` is enabled. */
    public static final String RISH_REL = "runtime/shizuku/rish";
    /** Native Rust Wireless ADB + Shizuku wrapper installed by `agy-adb-bridge`. */
    public static final String PLUGIN_RISH_REL = "usr/bin/rish";

    private final Context appContext;

    public RishLocator(Context context) {
        this.appContext = context.getApplicationContext();
    }

    public File rishBinary() {
        File files = appContext.getFilesDir();
        File pluginWrapper = new File(files, PLUGIN_RISH_REL);
        if (pluginWrapper.isFile() && pluginWrapper.canExecute()) {
            return pluginWrapper;
        }
        return new File(files, RISH_REL);
    }
}
