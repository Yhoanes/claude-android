package com.cc.ide.core;

import android.util.Base64;

import com.cc.ide.util.IoUtil;
import com.cc.ide.util.ProcessUtils;

import org.json.JSONObject;

import java.io.File;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/** Probes Claude Code Host loopback server readiness on GET /api/info. */
public final class CoreReadyProbe {

    public static final long READY_TIMEOUT_MS = 45_000L;

    /** Header / cookie that authenticate every request to the loopback host. */
    public static final String HOST_TOKEN_HEADER = "X-CC-Host-Token";
    public static final String HOST_TOKEN_COOKIE = "cc_host_token";

    private CoreReadyProbe() {
    }

    public static String basicAuthHeader(String password) {
        String raw = "claude:" + (password != null ? password : "");
        return "Basic " + Base64.encodeToString(raw.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
    }

    public static boolean probeOnce(int port, String csrf) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL("http://127.0.0.1:" + port + "/api/info");
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(900);
            conn.setReadTimeout(1500);
            conn.setRequestProperty("Accept", "application/json");
            if (csrf != null && !csrf.isEmpty()) {
                conn.setRequestProperty(HOST_TOKEN_HEADER, csrf);
            }
            if (conn.getResponseCode() == 200) {
                try (InputStream in = conn.getInputStream()) {
                    String body = IoUtil.readAll(in, "UTF-8");
                    JSONObject obj = new JSONObject(body);
                    if (obj.optBoolean("ok", false)) {
                        return true;
                    }
                }
            }
        } catch (Exception ignored) {
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
        ProcessUtils.sleep(200);
        return false;
    }

    public static void warmDefaultWorkspace(int port, String password, File workspaceDir) {
        if (workspaceDir != null && !workspaceDir.isDirectory()) {
            workspaceDir.mkdirs();
        }
    }

    public static String mintSessionToken(int port, String password) {
        return password;
    }
}
