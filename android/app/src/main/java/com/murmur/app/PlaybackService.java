package com.murmur.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Base64;
import org.json.JSONObject;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Keeps Murmur playing when you leave the app or lock the phone.
 * Android freezes background apps unless they run a "media playback" service like this one, which
 * also shows the notification with previous / play-pause / next, and answers lock-screen and
 * headphone buttons. The page reports what's playing through MainActivity's bridge (setPlaying).
 */
public class PlaybackService extends Service {
    static final String ACTION_UPDATE = "com.murmur.app.UPDATE";
    static final String ACTION_CONTROL = "com.murmur.app.CONTROL";
    static final String ACTION_STOP = "com.murmur.app.STOP";
    private static final String CHANNEL = "playback";
    private static final int NOTIFICATION_ID = 1;
    // Newer Android puts music players only in the quick-settings panel. This second, plain notification puts the
    // same controls in the notification list too.
    private static final String CONTROLS_CHANNEL = "controls";
    private static final int CONTROLS_ID = 2;

    static volatile boolean running = false;

    private MediaSession session;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private String title = "", artist = "", album = "", artUrl = "";
    private long duration = 0, position = 0, positionAt = 0;
    private float speed = 1f;
    private boolean playing = false, shuffle = false, liked = false;
    private Bitmap art;

    /** Called from the page (any thread) whenever the song or play/pause state changes. */
    static void update(Context ctx, boolean playing, String title, String artist) {
        Intent i = new Intent(ctx, PlaybackService.class).setAction(ACTION_UPDATE)
                .putExtra("playing", playing).putExtra("title", title).putExtra("artist", artist);
        try {
            if (!running && playing && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i);
            else if (running) ctx.startService(i);
        } catch (Exception e) {
            // Android can refuse to start a service while the app is in the background; the next update tries again.
        }
    }

    /** Like update(), plus the album, cover picture and progress (lengths in milliseconds). */
    static void updateFull(Context ctx, String json) {
        boolean playing = false;
        try { playing = new JSONObject(json).optBoolean("playing", false); } catch (Exception ignored) {}
        Intent i = new Intent(ctx, PlaybackService.class).setAction(ACTION_UPDATE).putExtra("json", json).putExtra("playing", playing);
        try {
            if (!running && playing && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ctx.startForegroundService(i);
            else if (running) ctx.startService(i);
        } catch (Exception e) {
            // Android can refuse to start a service while the app is in the background; the next update tries again.
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        running = true;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "Now playing", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Shows the song that's playing, with play, pause and skip buttons.");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CONTROLS_CHANNEL) == null) {
            NotificationChannel ch = new NotificationChannel(CONTROLS_CHANNEL, "Music controls in the notification list", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Play, pause and skip in your notifications, besides the player in quick settings.");
            ch.setShowBadge(false);
            ch.setSound(null, null);
            nm.createNotificationChannel(ch);
        }
        session = new MediaSession(this, "Murmur");
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { MainActivity.control("play"); }
            @Override public void onPause() { MainActivity.control("pause"); }
            @Override public void onSkipToNext() { MainActivity.control("next"); }
            @Override public void onSkipToPrevious() { MainActivity.control("prev"); }
            @Override public void onStop() { MainActivity.control("pause"); }
            @Override public void onSeekTo(long pos) { MainActivity.control("seek" + Math.max(0, pos)); }
            // Shuffle and like buttons on the player (like Spotify's)
            @Override public void onCustomAction(String action, android.os.Bundle extras) { MainActivity.control(action); }
        });
        session.setSessionActivity(openAppIntent());
        session.setActive(true);

        PowerManager pm = getSystemService(PowerManager.class);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Murmur:playback");
        wakeLock.setReferenceCounted(false);
        WifiManager wm = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wm != null) {
            wifiLock = wm.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "Murmur:stream");
            wifiLock.setReferenceCounted(false);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_STOP.equals(action)) { shutDown(); return START_NOT_STICKY; }
        if (ACTION_CONTROL.equals(action)) {
            MainActivity.control(intent.getStringExtra("do"));
            return START_NOT_STICKY;
        }
        if (intent != null && intent.hasExtra("json")) {
            try {
                JSONObject j = new JSONObject(nz(intent.getStringExtra("json")));
                playing = j.optBoolean("playing", false);
                title = j.optString("title", ""); artist = j.optString("artist", ""); album = j.optString("album", "");
                duration = Math.max(0, j.optLong("duration", 0)); position = Math.max(0, j.optLong("position", 0));
                positionAt = SystemClock.elapsedRealtime();
                speed = (float) j.optDouble("speed", 1);
                shuffle = j.optBoolean("shuffle", false); liked = j.optBoolean("liked", false);
                String a = j.optString("art", "");
                if (!a.equals(artUrl)) { artUrl = a; art = null; loadArt(a); }
            } catch (Exception ignored) {}
        } else if (intent != null) {
            playing = intent.getBooleanExtra("playing", false);
            title = nz(intent.getStringExtra("title"));
            artist = nz(intent.getStringExtra("artist"));
            album = ""; duration = 0; position = 0;
        }
        Notification n = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        else startForeground(NOTIFICATION_ID, n);
        updateSession();
        showControls();
        // Hold the CPU and Wi-Fi awake only while music is actually playing.
        if (playing) {
            if (!wakeLock.isHeld()) wakeLock.acquire(6 * 60 * 60 * 1000L);
            if (wifiLock != null && !wifiLock.isHeld()) wifiLock.acquire();
        } else {
            if (wakeLock.isHeld()) wakeLock.release();
            if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        }
        return START_NOT_STICKY;
    }

    private Notification buildNotification() {
        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        b.setSmallIcon(R.drawable.ic_stat_murmur)
                .setContentTitle(title.isEmpty() ? "Murmur" : title)
                .setContentText(artist)
                .setContentIntent(openAppIntent())
                .setDeleteIntent(serviceIntent(ACTION_STOP, null, 9))
                .setOngoing(playing)
                .setShowWhen(false)
                .setSubText(album.isEmpty() ? null : album)
                .setLargeIcon(art)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_previous, "Previous", serviceIntent(ACTION_CONTROL, "prev", 1)).build())
                .addAction(new Notification.Action.Builder(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                        playing ? "Pause" : "Play", serviceIntent(ACTION_CONTROL, "toggle", 2)).build())
                .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_next, "Next", serviceIntent(ACTION_CONTROL, "next", 3)).build())
                .setStyle(new Notification.MediaStyle().setMediaSession(session.getSessionToken()).setShowActionsInCompactView(0, 1, 2));
        return b.build();
    }

    /** The now-playing notification in the notification list: pinned while Murmur plays, with the song's picture
     *  and previous / play-pause / next / like. (Android's own player in quick settings is separate.) */
    private void showControls() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (title.isEmpty()) { nm.cancel(CONTROLS_ID); return; }
        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CONTROLS_CHANNEL) : new Notification.Builder(this);
        b.setSmallIcon(R.drawable.ic_stat_murmur)
                .setContentTitle(title)
                .setContentText(artist)
                .setLargeIcon(art)
                .setContentIntent(openAppIntent())
                .setOngoing(true)                // pinned: it stays until Murmur is closed
                .setOnlyAlertOnce(true)
                .setShowWhen(false)
                .setGroup("murmur-controls")
                .setCategory(Notification.CATEGORY_TRANSPORT)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .addAction(new Notification.Action.Builder(R.drawable.n_prev, "Previous", serviceIntent(ACTION_CONTROL, "prev", 4)).build())
                .addAction(new Notification.Action.Builder(playing ? R.drawable.n_pause : R.drawable.n_play, playing ? "Pause" : "Play", serviceIntent(ACTION_CONTROL, "toggle", 5)).build())
                .addAction(new Notification.Action.Builder(R.drawable.n_next, "Next", serviceIntent(ACTION_CONTROL, "next", 6)).build())
                .addAction(new Notification.Action.Builder(liked ? R.drawable.n_heart_on : R.drawable.n_heart, liked ? "Liked" : "Like", serviceIntent(ACTION_CONTROL, "like", 8)).build())
                // The media look (icon buttons, picture on the side) without a media session, so it stays in the
                // notification list instead of moving into quick settings.
                .setStyle(new Notification.MediaStyle().setShowActionsInCompactView(0, 1, 2));
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) b.setPriority(Notification.PRIORITY_LOW);
        try { nm.notify(CONTROLS_ID, b.build()); } catch (Exception ignored) {}
    }

    private void updateSession() {
        MediaMetadata.Builder m = new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
                .putString(MediaMetadata.METADATA_KEY_ALBUM, album);
        if (duration > 0) m.putLong(MediaMetadata.METADATA_KEY_DURATION, duration);   // shows the progress bar
        if (art != null) m.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, art);
        session.setMetadata(m.build());
        long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE
                | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS | PlaybackState.ACTION_STOP;
        if (duration > 0) actions |= PlaybackState.ACTION_SEEK_TO;   // drag the bar to jump in the song
        session.setPlaybackState(new PlaybackState.Builder()
                .setActions(actions)
                .addCustomAction(new PlaybackState.CustomAction.Builder("shuffle", shuffle ? "Shuffle off" : "Shuffle on",
                        shuffle ? R.drawable.n_shuffle_on : R.drawable.n_shuffle).build())
                .addCustomAction(new PlaybackState.CustomAction.Builder("like", liked ? "Remove from Liked Songs" : "Save to Liked Songs",
                        liked ? R.drawable.n_heart_on : R.drawable.n_heart).build())
                .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED,
                        duration > 0 ? position : PlaybackState.PLAYBACK_POSITION_UNKNOWN, playing ? speed : 0f,
                        positionAt > 0 ? positionAt : SystemClock.elapsedRealtime())
                .build());
    }

    /** Fetches the cover (a web address or a data: picture) in the background, then refreshes the notification. */
    private void loadArt(final String url) {
        if (url == null || url.isEmpty()) return;
        new Thread(() -> {
            Bitmap b = null;
            try {
                if (url.startsWith("data:")) {
                    byte[] bytes = Base64.decode(url.substring(url.indexOf(',') + 1), Base64.DEFAULT);
                    b = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                } else if (url.startsWith("https://")) {
                    HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
                    c.setConnectTimeout(8000); c.setReadTimeout(8000);
                    try (InputStream in = c.getInputStream()) { b = BitmapFactory.decodeStream(in); }
                    finally { c.disconnect(); }
                }
                if (b != null && b.getWidth() > 512) b = Bitmap.createScaledBitmap(b, 512, Math.max(1, 512 * b.getHeight() / b.getWidth()), true);
            } catch (Exception ignored) {}
            final Bitmap got = b;
            if (got == null) return;
            new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
                if (!url.equals(artUrl) || !running) return;   // the song changed meanwhile
                art = got;
                updateSession();
                getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, buildNotification());
                showControls();
            });
        }).start();
    }

    private PendingIntent openAppIntent() {
        Intent i = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_REORDER_TO_FRONT);
        return PendingIntent.getActivity(this, 0, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private PendingIntent serviceIntent(String action, String what, int code) {
        Intent i = new Intent(this, PlaybackService.class).setAction(action);
        if (what != null) i.putExtra("do", what);
        return PendingIntent.getService(this, code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private void shutDown() {
        getSystemService(NotificationManager.class).cancel(CONTROLS_ID);
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE); else stopForeground(true);
        stopSelf();
    }

    /** Swiping Murmur away in Recents stops the music and the notification. */
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        MainActivity.control("pause");
        shutDown();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        running = false;
        getSystemService(NotificationManager.class).cancel(CONTROLS_ID);
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        if (session != null) session.release();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    private static String nz(String s) { return s == null ? "" : s; }
}
