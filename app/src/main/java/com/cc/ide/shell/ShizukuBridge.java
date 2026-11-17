package com.cc.ide.shell;

import android.content.Context;
import android.util.Log;

import com.cc.ide.util.IoUtil;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;

/**
 * Elevated shell (`uid=2000`) helper gated strictly on the `agy-adb-bridge` plugin
 * installed from Settings → Plugins.
 *
 * Out of the box (`agy-adb-bridge` not installed or disabled), `rish` stays off `PATH`
 * and zero ADB/Shizuku commands or system tweaks run.
 */
public final class ShizukuBridge {

    private static final String TAG = "CC_Shizuku";
    public static final String PLUGIN_ID = "agy-adb-bridge";

    private final Context appContext;
    private final RishLocator locator;
    private final RishExecutor executor;

    public ShizukuBridge(Context context) {
        this.appContext = context.getApplicationContext();
        this.locator = new RishLocator(context);
        this.executor = new RishExecutor(context);
    }

    /** True only when the user installed `agy-adb-bridge` in Settings → Plugins and left it enabled. */
    public static boolean isEnabled(Context ctx) {
        if (ctx == null) return false;
        try {
            File claudeDir = new File(ctx.getApplicationContext().getFilesDir(), ".claude");
            File pluginDir = new File(new File(claudeDir, "plugins-hub"), PLUGIN_ID);
            if (!pluginDir.isDirectory()) {
                return false;
            }
            File stateFile = new File(claudeDir, "android-plugins.json");
            if (!stateFile.isFile()) {
                return false;
            }
            try (FileInputStream fis = new FileInputStream(stateFile)) {
                String raw = IoUtil.readAll(fis, "UTF-8").trim();
                if (raw.isEmpty()) return false;
                JSONObject state = new JSONObject(raw);
                JSONObject plugins = state.optJSONObject("plugins");
                if (plugins == null) return false;
                JSONObject meta = plugins.optJSONObject(PLUGIN_ID);
                return meta != null && meta.optBoolean("enabled", true);
            }
        } catch (Throwable ignored) {
            return false;
        }
    }

    public boolean isEnabled() {
        return isEnabled(appContext);
    }

    public boolean isAvailable() {
        if (!isEnabled()) {
            return false;
        }
        File rish = locator.rishBinary();
        return rish.exists() && rish.canExecute();
    }

    /** Runs `cmd` via `agy-adb-bridge` / `rish` when the plugin is enabled. */
    public String exec(String cmd) {
        if (!isEnabled()) {
            return "error: agy-adb-bridge plugin is not installed or enabled (Settings > Plugins)";
        }
        return executor.exec(cmd);
    }

    /**
     * Links `runtime/shizuku/rish` -> `runtime/bin/rish` only while `agy-adb-bridge` is enabled
     * (so `agy-adb-bridge`'s `STOCK_RISH` fallback works without exposing `rish` before install).
     * Never deletes `usr/bin/rish` while the plugin is enabled.
     */
    public static void syncRishLink(Context ctx) {
        syncRishLink(ctx, isEnabled(ctx));
    }

    public static void syncRishLink(Context ctx, boolean pluginActive) {
        if (ctx == null) return;
        File files = ctx.getApplicationContext().getFilesDir();
        File real = new File(files, RishLocator.RISH_REL);
        File link = new File(files, "runtime/bin/rish");
        try {
            link.delete();
            if (pluginActive) {
                if (real.isFile()) {
                    android.system.Os.symlink(real.getAbsolutePath(), link.getAbsolutePath());
                }
            } else {
                new File(files, "usr/bin/rish").delete();
                new File(files, "usr/bin/agy-adb").delete();
                new File(files, "usr/bin/agy-adb-setup").delete();
            }
        } catch (Throwable t) {
            Log.w(TAG, "cannot sync rish link: " + t.getMessage());
        }
    }

    /**
     * Only when `agy-adb-bridge` is installed and enabled: whitelist the app from Doze and lift
     * Android 12-16's phantom process limit so long builds and subagents are not killed (signal 9).
     */
    public void applyBackgroundSurvivabilityTweaksAsync() {
        if (!isAvailable()) {
            return;
        }
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    String pkg = appContext.getPackageName();
                    String cmd = "dumpsys deviceidle whitelist +" + pkg + " >/dev/null 2>&1 || true; "
                            + "cmd appops set " + pkg + " RUN_IN_BACKGROUND allow >/dev/null 2>&1 || true; "
                            + "cmd appops set " + pkg + " RUN_ANY_IN_BACKGROUND allow >/dev/null 2>&1 || true; "
                            + "device_config set_sync_disabled_for_tests persistent >/dev/null 2>&1 || true; "
                            + "device_config put activity_manager max_phantom_processes 2147483647 >/dev/null 2>&1 || true; "
                            + "settings put global settings_enable_monitor_phantom_procs false >/dev/null 2>&1 || true";
                    String res = exec(cmd);
                    if (res != null && res.startsWith("error:")) {
                        Log.d(TAG, "survivability tweaks skipped (" + res + ")");
                    } else {
                        Log.i(TAG, "applied Doze whitelist & phantom process limit for " + pkg);
                    }
                } catch (Throwable e) {
                    Log.d(TAG, "survivability tweaks error: " + e.getMessage());
                }
            }
        }, "ShizukuTweaksThread");
        t.setDaemon(true);
        t.start();
    }
}
