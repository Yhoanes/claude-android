package com.cc.ide.core;

import com.cc.ide.install.EnvInstaller;
import com.cc.ide.runtime.RuntimeManager;

import java.io.File;
import java.util.Map;

/** Builds the clean Android ARM64 ProcessBuilder environment for Claude Code Host. */
public final class CoreEnvironment {

    private CoreEnvironment() {
    }

    public static void apply(RuntimeManager runtime, ProcessBuilder pb) {
        Map<String, String> env = pb.environment();
        File filesDir = runtime.appContext().getFilesDir();
        File bin = runtime.getBinDir();
        File cert = runtime.getCertFile();
        File claudeDir = runtime.getClaudeDir();
        File ocData = runtime.getOcDataDir();
        File prefix = EnvInstaller.prefix(runtime.appContext());
        File prefixBin = new File(prefix, "bin");
        File tmpDir = new File(prefix, "tmp");
        if (!tmpDir.isDirectory()) {
            tmpDir.mkdirs();
        }
        File localBin = new File(filesDir, ".local/bin");
        if (!localBin.isDirectory()) {
            localBin.mkdirs();
        }

        env.put("HOME", filesDir.getAbsolutePath());
        env.put("PREFIX", prefix.getAbsolutePath());
        env.put("TMPDIR", tmpDir.getAbsolutePath());
        env.put("CLAUDE_CODE_TMPDIR", tmpDir.getAbsolutePath());
        env.put("CLAUDE_CODE_DISABLE_MOUSE", "1");
        env.put("DISABLE_AUTOUPDATER", "1");
        env.put("CC_PORT", String.valueOf(runtime.getHttpsPort()));
        env.put("CC_HOST_TOKEN", runtime.getCsrfToken());
        MicBridge mic = MicBridge.current();
        if (mic != null) {
            env.put("CC_MIC_SOCKET", mic.socketName());
            env.put("CC_MIC_TOKEN", mic.token());
        }
        // API key: decrypted from the Android Keystore into the host's memory only.
        if (com.cc.ide.security.SecretStore.migratePlaintext(runtime.appContext())) {
            env.put("CC_SECRET_STORE", "1");
            String apiKey = com.cc.ide.security.SecretStore.loadApiKey(runtime.appContext());
            if (!apiKey.isEmpty()) {
                env.put("CC_SECRET_API_KEY", apiKey);
            }
        }
        env.put("CC_CLAUDE_BIN", new File(bin, "claude").getAbsolutePath());

        File defaultWs = runtime.getDefaultWorkspaceDir();
        if (defaultWs != null && defaultWs.isDirectory()) {
            env.put("CC_DEFAULT_WORKSPACE", defaultWs.getAbsolutePath());
        }

        env.put("XDG_CONFIG_HOME", new File(filesDir, ".config").getAbsolutePath());
        env.put("XDG_DATA_HOME", new File(filesDir, ".local/share").getAbsolutePath());
        env.put("XDG_STATE_HOME", new File(filesDir, ".local/state").getAbsolutePath());
        env.put("XDG_CACHE_HOME", new File(filesDir, ".cache").getAbsolutePath());
        env.put("CLAUDE_CONFIG_DIR", claudeDir.getAbsolutePath());
        env.put("ANTIGRAVITY_APP_DATA_DIR", ocData.getAbsolutePath());
        env.put("GHIDRA_HEADLESS_MAXMEM", "768M");

        File ccPtyBin = new File(bin, "cc-pty");
        if (ccPtyBin.isFile()) {
            env.put("CC_PTY_BIN", ccPtyBin.getAbsolutePath());
        }
        File ptyBin = new File(bin, "opencode-pty");
        if (ptyBin.isFile()) {
            env.put("OPENCODE_PTY_BIN", ptyBin.getAbsolutePath());
        }

        env.put("SSL_CERT_FILE", cert.getAbsolutePath());
        env.put("SSL_CERT_DIR", cert.getParentFile().getAbsolutePath());
        env.put("CURL_CA_BUNDLE", cert.getAbsolutePath());
        env.put("GIT_SSL_CAINFO", cert.getAbsolutePath());
        env.put("NODE_EXTRA_CA_CERTS", cert.getAbsolutePath());
        env.put("GIT_CONFIG_NOSYSTEM", "1");
        File gitCore = new File(prefix, "libexec/git-core");
        if (gitCore.isDirectory()) {
            env.put("GIT_EXEC_PATH", gitCore.getAbsolutePath());
        }

        File opensslCnf = new File(prefix, "etc/tls/openssl.cnf");
        File fallbackOpensslCnf = new File(cert.getParentFile(), "openssl.cnf");
        if (opensslCnf.isFile()) {
            env.put("OPENSSL_CONF", opensslCnf.getAbsolutePath());
        } else if (fallbackOpensslCnf.isFile()) {
            env.put("OPENSSL_CONF", fallbackOpensslCnf.getAbsolutePath());
        }

        String sysPath = env.get("PATH");
        String basePath = prefixBin.getAbsolutePath()
                + File.pathSeparator + bin.getAbsolutePath()
                + File.pathSeparator + localBin.getAbsolutePath();
        env.put("PATH", (sysPath == null || sysPath.isEmpty())
                ? basePath + ":/system/bin"
                : basePath + File.pathSeparator + sysPath);

        File bashBin = new File(prefixBin, "bash");
        env.put("SHELL", bashBin.isFile() ? bashBin.getAbsolutePath() : new File(bin, "bash").getAbsolutePath());
        env.put("BROWSER", new File(bin, "xdg-open").getAbsolutePath());
        String chromeShim = new File(bin, "chrome").getAbsolutePath();
        env.put("CHROME_PATH", chromeShim);
        env.put("PUPPETEER_EXECUTABLE_PATH", chromeShim);
        env.put("TERM", "xterm-256color");
        env.put("COLORTERM", "truecolor");
        env.put("LANG", "C.UTF-8");
        env.remove("LD_PRELOAD");
    }
}
