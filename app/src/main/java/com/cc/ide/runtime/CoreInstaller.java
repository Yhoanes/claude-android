package com.cc.ide.runtime;

import android.content.Context;
import android.util.Log;

import com.cc.ide.install.EnvInstaller;
import com.cc.ide.install.TarExtractor;
import com.cc.ide.util.AssetUnpacker;
import com.cc.ide.util.AtomicFileWriter;
import com.cc.ide.util.FileModeUtil;
import com.cc.ide.util.IoUtil;
import com.cc.ide.util.Sha256;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;

/** Phase 1: extract + verify Claude Code v2.1.325 runtime, host server, and Bionic Node. */
public final class CoreInstaller {

    private static final String TAG = "CoreInstaller";

    private CoreInstaller() {
    }

    public static void installCore(RuntimeManager rm) {
        Context ctx = rm.appContext();
        File runtimeDir = rm.getRuntimeDir();
        String expectedHash = getAssetManifestHash(ctx);
        boolean upToDate = isRuntimeUpToDate(rm, expectedHash);

        if (!upToDate) {
            Log.i(TAG, "extracting assets/runtime + core-archive (first launch or runtime update)");
            try {
                wipe(rm, runtimeDir);
                AssetUnpacker.unpackTree(ctx.getAssets(), RuntimePaths.RUNTIME_ASSET, runtimeDir);
            } catch (IOException e) {
                throw new IllegalStateException(
                        "cannot unpack assets/runtime into " + runtimeDir + ": " + e.getMessage(), e);
            }

            String manifestError = ManifestVerifier.verifyError(ctx, runtimeDir);
            if (manifestError != null) {
                throw new IllegalStateException("runtime integrity check failed: " + manifestError);
            }

            try (InputStream coreStream = ctx.getAssets().open(RuntimePaths.CORE_ARCHIVE_ASSET)) {
                TarExtractor.untarGz(coreStream, runtimeDir);
            } catch (IOException e) {
                throw new IllegalStateException(
                        "cannot extract " + RuntimePaths.CORE_ARCHIVE_ASSET + ": " + e.getMessage(), e);
            }

            FileModeUtil.recursiveSetReadableExecutable(rm.getBinDir());
            if (rm.getLibDir().isDirectory()) {
                FileModeUtil.recursiveSetReadableExecutable(rm.getLibDir());
            }
            if (rm.getNodeLibDir().isDirectory()) {
                FileModeUtil.recursiveSetReadableExecutable(rm.getNodeLibDir());
            }
            File hostServe = new File(runtimeDir, "host/claude-serve.cjs");
            if (hostServe.isFile()) {
                FileModeUtil.setExec(hostServe);
            }
            File rish = new File(ctx.getFilesDir(), com.cc.ide.shell.RishLocator.RISH_REL);
            if (rish.isFile()) {
                FileModeUtil.setExec(rish);
            }

            writeMarker(rm.getRuntimeDir(), RuntimePaths.RUNTIME_MARKER, expectedHash);
        } else {
            Log.i(TAG, "runtime up to date (manifest hash matched); skipping extract");
        }

        try {
            AssetUnpacker.unpackTree(ctx.getAssets(), RuntimePaths.WEB_ASSET, rm.getWebDir());
            writeMarker(rm.getWebDir(), RuntimePaths.WEB_MARKER, "2");
        } catch (IOException e) {
            throw new IllegalStateException(
                    "cannot unpack assets/web into " + rm.getWebDir() + ": " + e.getMessage(), e);
        }

        rm.writeNetworkConfig();
        rm.startNetworkMonitor();
        OnboardingSeeder.seed(ctx, rm.getClaudeDir(), rm.getProjectsDir(), rm.getHttpsPort(), rm.getCsrfToken());
        ShellBridgeInstaller.installFallbackBridges(rm.getBinDir(), ctx);
        ShellBridgeInstaller.installOpenUrlShims(rm.getBinDir(), ctx);
        ensureUsrBinCoreLinks(ctx, rm.getBinDir());
        if (EnvInstaller.isInstalled(ctx)) {
            ShellBridgeInstaller.install(rm);
            ensureUsrBinCoreLinks(ctx, rm.getBinDir());
        }
        // rish is only on Claude's PATH while the user has Shizuku enabled.
        com.cc.ide.shell.ShizukuBridge.syncRishLink(ctx);
    }

    public static void ensureUsrBinCoreLinks(Context ctx, File runtimeBin) {
        try {
            File usrBin = new File(ctx.getFilesDir(), "usr/bin");
            if (!usrBin.isDirectory() && !usrBin.mkdirs()) {
                return;
            }
            for (String tool : new String[]{"claude", "node"}) {
                File src = new File(runtimeBin, tool);
                File dst = new File(usrBin, tool);
                if (src.isFile() && !dst.exists()) {
                    try {
                        android.system.Os.symlink(src.getAbsolutePath(), dst.getAbsolutePath());
                    } catch (Throwable ignored) {
                    }
                }
            }
        } catch (Throwable ignored) {
        }
    }

    private static boolean isRuntimeUpToDate(RuntimeManager rm, String expectedHash) {
        if (expectedHash == null || expectedHash.isEmpty()) {
            return false;
        }
        File marker = new File(rm.getRuntimeDir(), RuntimePaths.RUNTIME_MARKER);
        File core = new File(rm.getBinDir(), RuntimePaths.CORE_NAME);
        File claudeElf = new File(rm.getLibDir(), "claude.elf");
        File nodeElf = new File(rm.getBinDir(), "node.elf");
        if (!marker.isFile() || !core.isFile() || !claudeElf.isFile() || !nodeElf.isFile()) {
            return false;
        }
        try (FileInputStream fis = new FileInputStream(marker)) {
            String actual = IoUtil.readAll(fis, "UTF-8").trim();
            return expectedHash.equals(actual);
        } catch (Exception e) {
            return false;
        }
    }

    private static String getAssetManifestHash(Context ctx) {
        try (InputStream in = ctx.getAssets().open(RuntimePaths.MANIFEST_ASSET)) {
            return Sha256.of(in);
        } catch (Exception e) {
            Log.w(TAG, "cannot hash asset manifest: " + e.getMessage());
            return "";
        }
    }

    private static void writeMarker(File dir, String name, String content) {
        try {
            AtomicFileWriter.writeText(new File(dir, name), content + "\n");
        } catch (Exception e) {
            Log.w(TAG, "cannot write marker " + name + ": " + e.getMessage());
        }
    }

    private static void wipe(RuntimeManager rm, File dir) throws IOException {
        if (dir == null) {
            return;
        }
        try {
            android.system.StructStat st = android.system.Os.lstat(dir.getAbsolutePath());
            if (android.system.OsConstants.S_ISLNK(st.st_mode)) {
                if (!dir.delete()) {
                    try {
                        android.system.Os.remove(dir.getAbsolutePath());
                    } catch (Throwable t) {
                        throw new IOException("cannot remove symlink " + dir, t);
                    }
                }
                return;
            }
        } catch (Throwable ignored) {
            if (!dir.exists()) {
                return;
            }
        }
        assertSafeToWipe(rm, dir);
        if (!dir.exists()) {
            return;
        }
        if (dir.isDirectory()) {
            File[] children = dir.listFiles();
            if (children != null) {
                for (File child : children) {
                    wipe(rm, child);
                }
            }
        }
        if (!dir.delete()) {
            throw new IOException("cannot delete " + dir);
        }
    }

    private static void assertSafeToWipe(RuntimeManager rm, File dir) throws IOException {
        File files = rm.appContext().getFilesDir();
        String filesPath = files.getCanonicalPath();
        String target = dir.getCanonicalPath();
        if (!target.startsWith(filesPath + File.separator)) {
            throw new IOException("refusing to wipe outside filesDir: " + dir);
        }
        for (String protectedRel : new String[]{".claude", ".config", ".local", ".gemini", "workspace"}) {
            String protPath = new File(files, protectedRel).getCanonicalPath();
            if (target.equals(protPath)
                    || target.startsWith(protPath + File.separator)
                    || protPath.startsWith(target + File.separator)) {
                throw new IOException("refusing to wipe user data under " + protectedRel + ": " + dir);
            }
        }
    }
}
