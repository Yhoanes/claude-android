package com.cc.ide.shell;

import android.content.Context;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.util.Map;

/** Runs an elevated shell command through the `agy-adb-bridge` / `rish` bridge. */
public final class RishExecutor {

    private final Context appContext;
    private final RishLocator locator;

    public RishExecutor(Context context) {
        this.appContext = context.getApplicationContext();
        this.locator = new RishLocator(context);
    }

    /** Runs `cmd` as shell via rish. Returns combined stdout/stderr; errors are text. */
    public String exec(String cmd) {
        if (cmd == null || cmd.trim().isEmpty()) {
            return "error: empty command";
        }
        File rish = locator.rishBinary();
        if (!rish.isFile()) {
            return "error: rish not found at " + rish.getAbsolutePath();
        }
        if (!rish.canExecute()) {
            return "error: rish not executable: " + rish.getAbsolutePath();
        }
        File filesDir = appContext.getFilesDir();
        ProcessBuilder pb = new ProcessBuilder(
                rish.getAbsolutePath(),
                "-c",
                "env -u LD_LIBRARY_PATH " + cmd);
        pb.redirectErrorStream(true);
        Map<String, String> env = pb.environment();
        env.remove("LD_LIBRARY_PATH");
        env.put("HOME", filesDir.getAbsolutePath());
        env.put("PREFIX", new File(filesDir, "usr").getAbsolutePath());
        env.put("RISH_APPLICATION_ID", appContext.getPackageName());
        pb.directory(filesDir);
        Process process = null;
        try {
            process = pb.start();
            StringBuilder out = new StringBuilder();
            BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream()));
            String line;
            while ((line = reader.readLine()) != null) {
                out.append(line).append('\n');
            }
            int code = process.waitFor();
            String text = out.toString().trim();
            if (code != 0 && text.isEmpty()) {
                return "error: rish exited " + code;
            }
            return text;
        } catch (Exception e) {
            return "error: " + e.getMessage();
        } finally {
            if (process != null) {
                process.destroy();
            }
        }
    }
}
