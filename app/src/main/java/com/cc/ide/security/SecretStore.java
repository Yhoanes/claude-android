package com.cc.ide.security;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;

import com.cc.ide.util.IoUtil;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Keeps the user's Anthropic / provider API key encrypted with a hardware-backed
 * Android Keystore AES-256-GCM key. The plaintext key only ever lives in memory and is
 * handed to the host process through its environment; it is never written to disk.
 */
public final class SecretStore {

    private static final String TAG = "CC_SecretStore";
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "cc_api_key_v1";
    private static final String PREFS = "cc_secrets";
    private static final String PREF_API_KEY = "api_key_gcm";
    private static final int GCM_TAG_BITS = 128;
    private static final String[] SECRET_ENV_NAMES = {"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"};

    private SecretStore() {
    }

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static SecretKey getOrCreateKey() throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        KeyStore.Entry entry = ks.getEntry(KEY_ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        }
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        gen.init(new KeyGenParameterSpec.Builder(KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build());
        return gen.generateKey();
    }

    /** Encrypts and stores the key. Returns false if the Keystore is unusable. */
    public static synchronized boolean saveApiKey(Context ctx, String apiKey) {
        String clean = apiKey == null ? "" : apiKey.trim();
        if (clean.isEmpty()) {
            clearApiKey(ctx);
            return true;
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
            byte[] iv = cipher.getIV();
            byte[] ct = cipher.doFinal(clean.getBytes(StandardCharsets.UTF_8));
            byte[] blob = new byte[1 + iv.length + ct.length];
            blob[0] = (byte) iv.length;
            System.arraycopy(iv, 0, blob, 1, iv.length);
            System.arraycopy(ct, 0, blob, 1 + iv.length, ct.length);
            return prefs(ctx).edit()
                    .putString(PREF_API_KEY, Base64.encodeToString(blob, Base64.NO_WRAP))
                    .commit();
        } catch (Throwable t) {
            Log.e(TAG, "cannot encrypt API key: " + t.getClass().getSimpleName());
            return false;
        }
    }

    /** Returns the decrypted key, or "" if none is stored or it cannot be decrypted. */
    public static synchronized String loadApiKey(Context ctx) {
        String stored = prefs(ctx).getString(PREF_API_KEY, null);
        if (stored == null || stored.isEmpty()) {
            return "";
        }
        try {
            byte[] blob = Base64.decode(stored, Base64.NO_WRAP);
            int ivLen = blob[0] & 0xff;
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(),
                    new GCMParameterSpec(GCM_TAG_BITS, blob, 1, ivLen));
            byte[] pt = cipher.doFinal(blob, 1 + ivLen, blob.length - 1 - ivLen);
            return new String(pt, StandardCharsets.UTF_8);
        } catch (Throwable t) {
            Log.e(TAG, "cannot decrypt API key: " + t.getClass().getSimpleName());
            return "";
        }
    }

    public static synchronized void clearApiKey(Context ctx) {
        prefs(ctx).edit().remove(PREF_API_KEY).commit();
    }

    /** True when the Keystore can create/load the wrapping key. */
    public static boolean isUsable() {
        try {
            getOrCreateKey();
            return true;
        } catch (Throwable t) {
            Log.e(TAG, "Android Keystore unavailable: " + t.getClass().getSimpleName());
            return false;
        }
    }

    /**
     * Moves any plaintext key left by older versions into the Keystore. The host scrubs the
     * plaintext copies itself, but only after this returned true (so a Keystore failure
     * never loses the user's key).
     */
    public static synchronized boolean migratePlaintext(Context ctx) {
        if (!isUsable()) {
            return false;
        }
        if (!loadApiKey(ctx).isEmpty()) {
            return true;
        }
        String found = findPlaintextKey(ctx.getFilesDir());
        if (found.isEmpty()) {
            return true;
        }
        boolean ok = saveApiKey(ctx, found);
        if (ok) {
            Log.i(TAG, "migrated plaintext API key into Android Keystore");
        }
        return ok;
    }

    private static String findPlaintextKey(File filesDir) {
        File claudeDir = new File(filesDir, ".claude");
        try {
            JSONObject settings = readJson(new File(claudeDir, "settings.json"));
            JSONObject env = settings != null ? settings.optJSONObject("env") : null;
            if (env != null) {
                for (String name : SECRET_ENV_NAMES) {
                    String v = env.optString(name, "").trim();
                    if (!v.isEmpty()) {
                        return v;
                    }
                }
            }
            JSONObject hostCfg = readJson(new File(claudeDir, "android-host/host-config.json"));
            JSONArray vars = hostCfg != null ? hostCfg.optJSONArray("claudeCode.environmentVariables") : null;
            if (vars != null) {
                for (int i = 0; i < vars.length(); i++) {
                    JSONObject o = vars.optJSONObject(i);
                    if (o == null) continue;
                    String name = o.optString("name", "");
                    for (String secretName : SECRET_ENV_NAMES) {
                        if (secretName.equals(name) && !o.optString("value", "").trim().isEmpty()) {
                            return o.optString("value", "").trim();
                        }
                    }
                }
            }
            for (File f : new File[]{new File(filesDir, ".claude.json"), new File(claudeDir, ".claude.json"),
                    new File(claudeDir, "config.json")}) {
                JSONObject cj = readJson(f);
                String v = cj != null ? cj.optString("primaryApiKey", "").trim() : "";
                if (!v.isEmpty()) {
                    return v;
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "plaintext key scan failed: " + t.getClass().getSimpleName());
        }
        return "";
    }

    private static JSONObject readJson(File f) {
        if (!f.isFile()) {
            return null;
        }
        try (FileInputStream in = new FileInputStream(f)) {
            String txt = IoUtil.readAll(in, "UTF-8").trim();
            return txt.isEmpty() ? null : new JSONObject(txt);
        } catch (Throwable t) {
            return null;
        }
    }
}
