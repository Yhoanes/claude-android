package com.cc.ide.core;

import android.content.Context;
import android.os.FileObserver;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.cc.ide.bridge.NotificationBridge;
import com.cc.ide.oauth.OAuthManager;
import com.cc.ide.ui.MainActivity;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Dispatches external browser URLs and notifications from the core's stdout stream
 * or the app-private $HOME/.open_url_queue and $HOME/.notify_queue IPC files.
 *
 * Security & battery note:
 *  - No exported BroadcastReceiver is registered (prevents external apps from spoofing URLs).
 *  - Uses kernel inotify (FileObserver) on the private app data directory; a slow fallback
 *    poller starts ONLY if FileObserver fails to initialize.
 */
public final class OpenUrlWatcher {

    private static final String TAG = "CC_UrlWatcher";
    public static final String QUEUE_FILE_NAME = ".open_url_queue";
    public static final String NOTIFY_QUEUE_FILE_NAME = ".notify_queue";
    private static final Pattern URL_PATTERN =
            Pattern.compile("https?://[\\w\\-\\.\\~:\\?\\#\\[\\]\\@\\!\\$\\&\\'\\(\\)\\*\\+,;=%/]+");

    private final Context appContext;
    private final OAuthManager oauth = new OAuthManager();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final Object queueLock = new Object();
    private final Object notifyLock = new Object();
    private final File queueFile;
    private final File notifyQueueFile;

    private volatile String lastDispatchedUrl = "";
    private volatile long lastDispatchedTime = 0;
    private FileObserver queueObserver;
    private ScheduledExecutorService fallbackPoller;

    public OpenUrlWatcher(Context context) {
        this.appContext = context.getApplicationContext();
        this.queueFile = new File(this.appContext.getFilesDir(), QUEUE_FILE_NAME);
        this.notifyQueueFile = new File(this.appContext.getFilesDir(), NOTIFY_QUEUE_FILE_NAME);
    }

    @SuppressWarnings("deprecation")
    public void start() {
        try {
            if (queueFile.isFile()) {
                queueFile.delete();
            }
            NotificationBridge.syncActiveSnapshot(appContext);
        } catch (Throwable ignored) {
        }

        boolean observerStarted = false;
        try {
            final int mask = FileObserver.CLOSE_WRITE | FileObserver.MODIFY
                    | FileObserver.MOVED_TO | FileObserver.CREATE;
            queueObserver = new FileObserver(appContext.getFilesDir().getAbsolutePath(), mask) {
                @Override
                public void onEvent(int event, String path) {
                    if (QUEUE_FILE_NAME.equals(path)) {
                        drainQueueFile();
                    } else if (NOTIFY_QUEUE_FILE_NAME.equals(path)) {
                        drainNotifyQueueFile();
                    }
                }
            };
            queueObserver.startWatching();
            observerStarted = true;
        } catch (Throwable t) {
            Log.w(TAG, "FileObserver setup notice: " + t.getMessage());
        }

        if (!observerStarted) {
            try {
                fallbackPoller = Executors.newSingleThreadScheduledExecutor(r -> {
                    Thread t = new Thread(r, "CcUrlQueueFallback");
                    t.setDaemon(true);
                    return t;
                });
                fallbackPoller.scheduleWithFixedDelay(() -> {
                    drainQueueFile();
                    drainNotifyQueueFile();
                }, 2500, 2500, TimeUnit.MILLISECONDS);
            } catch (Throwable t) {
                Log.w(TAG, "fallbackPoller setup notice: " + t.getMessage());
            }
        }
    }

    private void drainNotifyQueueFile() {
        if (!notifyQueueFile.isFile() || notifyQueueFile.length() == 0) {
            return;
        }
        List<String> lines = new ArrayList<>();
        synchronized (notifyLock) {
            if (!notifyQueueFile.isFile() || notifyQueueFile.length() == 0) {
                return;
            }
            File snap = new File(notifyQueueFile.getParentFile(), NOTIFY_QUEUE_FILE_NAME + ".drain");
            snap.delete();
            File readTarget = notifyQueueFile.renameTo(snap) ? snap : notifyQueueFile;
            try (BufferedReader br = new BufferedReader(
                    new InputStreamReader(new FileInputStream(readTarget), StandardCharsets.UTF_8))) {
                String line;
                while ((line = br.readLine()) != null) {
                    String trimmed = line.trim();
                    if (!trimmed.isEmpty()) {
                        lines.add(trimmed);
                    }
                }
            } catch (Throwable ignored) {
            } finally {
                readTarget.delete();
            }
        }
        for (String raw : lines) {
            try {
                JSONObject obj = new JSONObject(raw);
                String action = obj.optString("action", "post");
                if ("cancel".equals(action)) {
                    NotificationBridge.cancelLocal(appContext, obj.optString("tag", ""));
                } else {
                    NotificationBridge.postLocal(
                            appContext,
                            obj.optString("title", ""),
                            obj.optString("message", ""),
                            obj.optString("tag", ""));
                }
            } catch (Throwable ignored) {
            }
        }
    }

    public void stop() {
        try {
            if (queueObserver != null) {
                queueObserver.stopWatching();
                queueObserver = null;
            }
        } catch (Throwable ignored) {
        }
        try {
            if (fallbackPoller != null) {
                fallbackPoller.shutdownNow();
                fallbackPoller = null;
            }
        } catch (Throwable ignored) {
        }
    }

    private void drainQueueFile() {
        if (!queueFile.isFile() || queueFile.length() == 0) {
            return;
        }
        List<String> urls = new ArrayList<>();
        synchronized (queueLock) {
            if (!queueFile.isFile() || queueFile.length() == 0) {
                return;
            }
            File snap = new File(queueFile.getParentFile(), QUEUE_FILE_NAME + ".drain");
            snap.delete();
            File readTarget = queueFile.renameTo(snap) ? snap : queueFile;
            try (BufferedReader br = new BufferedReader(
                    new InputStreamReader(new FileInputStream(readTarget), StandardCharsets.UTF_8))) {
                String line;
                while ((line = br.readLine()) != null) {
                    String trimmed = line.trim();
                    if (!trimmed.isEmpty()) {
                        urls.add(trimmed);
                    }
                }
            } catch (Throwable ignored) {
            } finally {
                readTarget.delete();
            }
        }
        for (String u : urls) {
            dispatchIfValid(u);
        }
    }

    /** Detects stdout OPEN_URL prefixes or auth URLs; called by the stream reader. */
    public void handleStreamLine(String line) {
        if (line == null) {
            return;
        }
        for (String prefix : new String[]{"CC_OPEN_URL=", "AGY_OPEN_URL=", "ANTIGRAVITY_OPEN_URL:", "ANTIGRAVITY_OPEN_URL="}) {
            int at = line.indexOf(prefix);
            if (at >= 0) {
                String url = line.substring(at + prefix.length()).trim();
                dispatchIfValid(url);
                return;
            }
        }
        if (line.contains("accounts.google.com") || line.contains("oauth")
                || line.contains("github.com/login/device") || line.contains("auth.openai.com")
                || line.contains("claude.ai/oauth") || (line.contains("/auth/callback") && line.contains("http"))) {
            Matcher m = URL_PATTERN.matcher(line);
            while (m.find()) {
                String candidate = m.group();
                if (candidate.startsWith("http://") || candidate.startsWith("https://")) {
                    if (!candidate.contains("127.0.0.1") && !candidate.contains("localhost")) {
                        dispatchIfValid(candidate);
                    }
                }
            }
        }
    }

    public void dispatchIfValid(String url) {
        if (url == null) return;
        url = url.trim();
        if (url.isEmpty() || (!url.startsWith("http://") && !url.startsWith("https://"))) return;

        long now = System.currentTimeMillis();
        if (url.equals(lastDispatchedUrl) && (now - lastDispatchedTime) < 1500) {
            return;
        }
        lastDispatchedUrl = url;
        lastDispatchedTime = now;
        openUrl(url);
    }

    private void openUrl(final String url) {
        mainHandler.post(() -> {
            Context target = (MainActivity.activeActivity != null)
                    ? MainActivity.activeActivity
                    : appContext;
            boolean opened = oauth.openInBrowser(target, url);
            if (!opened) {
                Log.w(TAG, "no browser accepted the url");
            }
        });
    }
}
