package com.cc.ide.runtime;

import android.content.Context;
import android.os.Environment;
import android.util.Log;

import com.cc.ide.util.AtomicFileWriter;
import com.cc.ide.util.IoUtil;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;

/**
 * Seeds Claude Code Android user configuration on launch:
 *  - ~/.claude/CLAUDE.md (Android ARM64 environment rules)
 *  - ~/.claude/settings.json (sandbox.enabled = false)
 *  - ~/.claude/skills/{docx,pdf,pdf-reading,pptx,xlsx,frontend-design,draft-design-system}
 *  - ~/.claude/.claude.json (engine global config: default-folder trust + mcpServers container)
 *  - /storage/emulated/0/Documents/ClaudeCode/CLAUDE.md
 *  - ~/.gitconfig (safe.directory = *)
 */
public final class OnboardingSeeder {

    private static final String TAG = "OnboardingSeeder";

    private OnboardingSeeder() {
    }

    public static void seed(Context context, File claudeDir, File projectsDir, int port, String csrfToken) {
        try {
            File filesDir = context.getFilesDir();
            mkdirsQuiet(claudeDir);
            mkdirsQuiet(projectsDir);
            mkdirsQuiet(new File(claudeDir, "skills"));
            mkdirsQuiet(new File(claudeDir, "rules"));
            mkdirsQuiet(new File(claudeDir, "plugins-hub"));

            File claudeMd = new File(claudeDir, "CLAUDE.md");
            seedBundledClaudeMd(context, claudeMd);

            try {
                File defaultWs = new File(Environment.getExternalStorageDirectory(), "Documents/ClaudeCode");
                if ((defaultWs.isDirectory() || defaultWs.mkdirs()) && defaultWs.canWrite()) {
                    File wsClaudeMd = new File(defaultWs, "CLAUDE.md");
                    if (!wsClaudeMd.isFile()) {
                        seedBundledClaudeMd(context, wsClaudeMd);
                    }
                    ensureClaudeJsonTrust(filesDir, defaultWs);
                }
            } catch (Throwable ignored) {
            }

            ensureClaudeSettingsJson(claudeDir);
            seedOfficialBundledSkills(filesDir, new File(claudeDir, "skills"));
            ensureGitSafeDirectory(filesDir);
        } catch (Exception e) {
            Log.w(TAG, "OnboardingSeeder notice: " + e.getMessage());
        }
    }

    private static void seedBundledClaudeMd(Context ctx, File dst) {
        try (InputStream in = ctx.getAssets().open(RuntimePaths.SEED_ASSET + "/CLAUDE.md")) {
            String raw = IoUtil.readAll(in, "UTF-8");
            String pkg = ctx.getPackageName();
            if (!"com.cc.ide".equals(pkg)) {
                raw = raw.replace("com.cc.ide", pkg);
            }
            if (!dst.isFile() || dst.length() == 0) {
                AtomicFileWriter.writeText(dst, raw);
                return;
            }
            try (FileInputStream fis = new FileInputStream(dst)) {
                String existing = IoUtil.readAll(fis, "UTF-8");
                if (existing.contains("Claude Code Android Agent Rules") && !existing.equals(raw)) {
                    AtomicFileWriter.writeText(dst, raw);
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "cannot seed CLAUDE.md: " + e.getMessage());
        }
    }

    private static void ensureClaudeSettingsJson(File claudeDir) {
        try {
            File settingsFile = new File(claudeDir, "settings.json");
            JSONObject root = new JSONObject();
            if (settingsFile.isFile() && settingsFile.length() > 0) {
                try (FileInputStream fis = new FileInputStream(settingsFile)) {
                    String txt = IoUtil.readAll(fis, "UTF-8").trim();
                    if (!txt.isEmpty()) {
                        root = new JSONObject(txt);
                    }
                } catch (Exception ignored) {
                }
            }
            boolean dirty = false;
            JSONObject sandbox = root.optJSONObject("sandbox");
            if (sandbox == null) {
                sandbox = new JSONObject();
                root.put("sandbox", sandbox);
                dirty = true;
            }
            if (!sandbox.has("enabled") || sandbox.optBoolean("enabled", true)) {
                sandbox.put("enabled", false);
                dirty = true;
            }
            if (dirty || !settingsFile.isFile()) {
                AtomicFileWriter.writeText(settingsFile, root.toString(2) + "\n");
            }
        } catch (Exception e) {
            Log.w(TAG, "ensureClaudeSettingsJson notice: " + e.getMessage());
        }
    }

    private static void ensureClaudeJsonTrust(File filesDir, File defaultWs) {
        try {
            // Engine global config = $CLAUDE_CONFIG_DIR/.claude.json (CLAUDE_CONFIG_DIR = ~/.claude).
            File claudeJson = new File(filesDir, ".claude/.claude.json");
            JSONObject root = new JSONObject();
            if (claudeJson.isFile() && claudeJson.length() > 0) {
                try (FileInputStream fis = new FileInputStream(claudeJson)) {
                    String txt = IoUtil.readAll(fis, "UTF-8").trim();
                    if (!txt.isEmpty()) {
                        root = new JSONObject(txt);
                    }
                } catch (Exception ignored) {
                }
            }
            JSONObject projects = root.optJSONObject("projects");
            if (projects == null) {
                projects = new JSONObject();
                root.put("projects", projects);
            }
            String wsAbs = defaultWs.getAbsolutePath();
            JSONObject wsEntry = projects.optJSONObject(wsAbs);
            if (wsEntry == null) {
                wsEntry = new JSONObject();
                projects.put(wsAbs, wsEntry);
            }
            wsEntry.put("hasTrustDialogAccepted", true);
            if (!root.has("mcpServers")) {
                root.put("mcpServers", new JSONObject());
            }
            AtomicFileWriter.writeText(claudeJson, root.toString(2) + "\n");
        } catch (Exception ignored) {
        }
    }

    private static void seedOfficialBundledSkills(File filesDir, File skillsDstDir) {
        File bundledRoot = new File(filesDir, "runtime/bundled-skills");
        if (!bundledRoot.isDirectory()) {
            return;
        }
        File[] children = bundledRoot.listFiles();
        if (children == null) {
            return;
        }
        for (File skillDir : children) {
            if (!skillDir.isDirectory()) continue;
            File dst = new File(skillsDstDir, skillDir.getName());
            if (!dst.exists()) {
                copyRecursiveQuiet(skillDir, dst);
            }
        }
    }

    private static void copyRecursiveQuiet(File src, File dst) {
        if (src.isDirectory()) {
            mkdirsQuiet(dst);
            File[] items = src.listFiles();
            if (items != null) {
                for (File it : items) {
                    copyRecursiveQuiet(it, new File(dst, it.getName()));
                }
            }
        } else if (src.isFile()) {
            try (FileInputStream in = new FileInputStream(src);
                 FileOutputStream out = new FileOutputStream(dst)) {
                byte[] buf = new byte[16384];
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                }
            } catch (Exception ignored) {
            }
        }
    }

    private static void ensureGitSafeDirectory(File filesDir) {
        try {
            File gitConfig = new File(filesDir, ".gitconfig");
            if (!gitConfig.isFile()) {
                AtomicFileWriter.writeText(gitConfig, "[safe]\n\tdirectory = *\n");
            }
        } catch (Exception ignored) {
        }
    }

    private static void mkdirsQuiet(File dir) {
        if (dir != null && !dir.isDirectory()) {
            dir.mkdirs();
        }
    }
}
