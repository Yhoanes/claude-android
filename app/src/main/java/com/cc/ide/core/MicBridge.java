package com.cc.ide.core;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.net.Credentials;
import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import android.util.Log;

import com.cc.ide.ui.MainActivity;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;

/**
 * Microphone bridge for the official voice dictation. The extension runs `arecord`
 * (runtime/bin/arecord -> host/cc-arecord.cjs), which connects here and receives raw
 * 16 kHz mono 16-bit PCM recorded with AudioRecord.
 *
 * Only connections from this app's own uid that present the per-boot token are served,
 * and the microphone permission is requested the first time dictation is used.
 */
public final class MicBridge {

    private static final String TAG = "CC_Mic";
    public static final int REQUEST_CODE = 1006;
    private static final int SAMPLE_RATE = 16000;
    private static final long PERMISSION_WAIT_MS = 30_000L;

    private static volatile MicBridge current;
    private static volatile int permissionAnswer = -1; // -1 pending, 0 denied, 1 granted

    private final Context appContext;
    private final String socketName;
    private final String token;
    private volatile boolean running;
    private volatile LocalSocket activeClient;
    private LocalServerSocket server;

    private MicBridge(Context context) {
        this.appContext = context.getApplicationContext();
        this.socketName = appContext.getPackageName() + ".mic." + randomHex(6);
        this.token = randomHex(32);
    }

    public static MicBridge current() {
        return current;
    }

    public String socketName() {
        return socketName;
    }

    public String token() {
        return token;
    }

    public static synchronized MicBridge start(Context context) {
        if (current != null) {
            return current;
        }
        MicBridge bridge = new MicBridge(context);
        try {
            bridge.server = new LocalServerSocket(bridge.socketName);
        } catch (IOException e) {
            Log.w(TAG, "mic bridge unavailable: " + e.getMessage());
            return null;
        }
        bridge.running = true;
        Thread t = new Thread(bridge::acceptLoop, "CcMicAccept");
        t.setDaemon(true);
        t.start();
        current = bridge;
        return bridge;
    }

    public static synchronized void stop() {
        MicBridge bridge = current;
        current = null;
        if (bridge == null) {
            return;
        }
        bridge.running = false;
        closeQuietly(bridge.activeClient);
        // LocalServerSocket.accept() is not interrupted by close(): wake it with a dummy client.
        try (LocalSocket wake = new LocalSocket()) {
            wake.connect(new LocalSocketAddress(bridge.socketName));
        } catch (IOException ignored) {
        }
        try {
            bridge.server.close();
        } catch (IOException ignored) {
        }
    }

    /** Called by MainActivity.onRequestPermissionsResult for REQUEST_CODE. */
    public static void onPermissionResult(boolean granted) {
        permissionAnswer = granted ? 1 : 0;
    }

    private void acceptLoop() {
        while (running) {
            try {
                final LocalSocket client = server.accept();
                if (!running) {
                    closeQuietly(client);
                    break;
                }
                Thread t = new Thread(() -> serve(client), "CcMicClient");
                t.setDaemon(true);
                t.start();
            } catch (IOException e) {
                if (running) {
                    Log.w(TAG, "accept failed: " + e.getMessage());
                }
            }
        }
    }

    private void serve(LocalSocket client) {
        try {
            Credentials cred = client.getPeerCredentials();
            if (cred == null || cred.getUid() != android.os.Process.myUid()) {
                Log.w(TAG, "rejected mic client from foreign uid");
                return;
            }
            client.setSoTimeout(3000);
            if (!tokenMatches(readLine(client.getInputStream()))) {
                Log.w(TAG, "rejected mic client without dictation token");
                return;
            }
            client.setSoTimeout(0);
            if (!ensurePermission()) {
                Log.i(TAG, "microphone permission not granted");
                return;
            }
            LocalSocket previous = activeClient;
            activeClient = client;
            closeQuietly(previous);
            record(client);
        } catch (Throwable t) {
            Log.w(TAG, "mic session ended: " + t.getMessage());
        } finally {
            if (activeClient == client) {
                activeClient = null;
            }
            closeQuietly(client);
        }
    }

    private void record(LocalSocket client) throws IOException {
        int minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        int bufBytes = Math.max(minBuf, 3200) * 2;
        AudioRecord rec = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufBytes);
        if (rec.getState() != AudioRecord.STATE_INITIALIZED) {
            rec.release();
            throw new IOException("AudioRecord could not be initialized");
        }
        OutputStream out = client.getOutputStream();
        byte[] chunk = new byte[2048];
        try {
            rec.startRecording();
            while (running && activeClient == client) {
                int n = rec.read(chunk, 0, chunk.length);
                if (n < 0) {
                    throw new IOException("AudioRecord read error " + n);
                }
                if (n > 0) {
                    out.write(chunk, 0, n); // throws once arecord exits (dictation stopped)
                }
            }
        } finally {
            try {
                rec.stop();
            } catch (Throwable ignored) {
            }
            rec.release();
        }
    }

    private boolean ensurePermission() {
        if (appContext.checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED) {
            return true;
        }
        final Activity activity = MainActivity.activeActivity;
        if (activity == null) {
            return false;
        }
        permissionAnswer = -1;
        activity.runOnUiThread(() -> {
            try {
                activity.requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQUEST_CODE);
            } catch (Throwable t) {
                permissionAnswer = 0;
            }
        });
        long deadline = System.currentTimeMillis() + PERMISSION_WAIT_MS;
        while (permissionAnswer == -1 && System.currentTimeMillis() < deadline) {
            try {
                Thread.sleep(150);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return false;
            }
        }
        return appContext.checkSelfPermission(Manifest.permission.RECORD_AUDIO)
                == PackageManager.PERMISSION_GRANTED;
    }

    private boolean tokenMatches(String candidate) {
        if (candidate == null) {
            return false;
        }
        return MessageDigest.isEqual(candidate.getBytes(StandardCharsets.UTF_8),
                token.getBytes(StandardCharsets.UTF_8));
    }

    private static String readLine(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 128; i++) {
            int c = in.read();
            if (c < 0 || c == '\n') {
                return sb.toString();
            }
            sb.append((char) c);
        }
        return null;
    }

    private static String randomHex(int bytes) {
        byte[] raw = new byte[bytes];
        new SecureRandom().nextBytes(raw);
        StringBuilder sb = new StringBuilder(bytes * 2);
        for (byte b : raw) {
            sb.append(String.format("%02x", b & 0xff));
        }
        return sb.toString();
    }

    private static void closeQuietly(LocalSocket s) {
        if (s == null) {
            return;
        }
        try {
            s.close();
        } catch (IOException ignored) {
        }
    }
}
