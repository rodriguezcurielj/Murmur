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

    static volatile boolean running = false;

    private MediaSession session;
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private String title = "", artist = "";
    private boolean playing = false;

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
        session = new MediaSession(this, "Murmur");
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { MainActivity.control("play"); }
            @Override public void onPause() { MainActivity.control("pause"); }
            @Override public void onSkipToNext() { MainActivity.control("next"); }
            @Override public void onSkipToPrevious() { MainActivity.control("prev"); }
            @Override public void onStop() { MainActivity.control("pause"); }
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
        if (intent != null) {
            playing = intent.getBooleanExtra("playing", false);
            title = nz(intent.getStringExtra("title"));
            artist = nz(intent.getStringExtra("artist"));
        }
        Notification n = buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        else startForeground(NOTIFICATION_ID, n);
        updateSession();
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
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_previous, "Previous", serviceIntent(ACTION_CONTROL, "prev", 1)).build())
                .addAction(new Notification.Action.Builder(playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play,
                        playing ? "Pause" : "Play", serviceIntent(ACTION_CONTROL, "toggle", 2)).build())
                .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_next, "Next", serviceIntent(ACTION_CONTROL, "next", 3)).build())
                .setStyle(new Notification.MediaStyle().setMediaSession(session.getSessionToken()).setShowActionsInCompactView(0, 1, 2));
        return b.build();
    }

    private void updateSession() {
        session.setMetadata(new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
                .build());
        session.setPlaybackState(new PlaybackState.Builder()
                .setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE
                        | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS | PlaybackState.ACTION_STOP)
                .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, PlaybackState.PLAYBACK_POSITION_UNKNOWN, playing ? 1f : 0f)
                .build());
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
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
        if (session != null) session.release();
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    private static String nz(String s) { return s == null ? "" : s; }
}
