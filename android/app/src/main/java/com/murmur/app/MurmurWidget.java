package com.murmur.app;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Build;
import android.os.Bundle;
import android.util.SizeF;
import android.view.View;
import android.widget.RemoteViews;
import java.io.File;
import java.io.FileOutputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * Home-screen widget (also fits the Razr's outside screen as a small square): the song that's playing, its cover,
 * and previous / play-pause / next / like. PlaybackService saves what's playing and calls refresh() on every change.
 * Three looks, picked by size: tiny (cover + play), wide (one row) and large (big cover with buttons under it).
 */
public class MurmurWidget extends AppWidgetProvider {
    private static final String PREFS = "murmur_widget";
    private static final String ART_FILE = "widget_art.png";

    /** Remember what's playing, so the widget still shows it after Murmur closes or the phone restarts. */
    static void save(Context ctx, String title, String artist, boolean playing, boolean liked) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString("title", title).putString("artist", artist).putBoolean("playing", playing).putBoolean("liked", liked).apply();
    }

    static void saveArt(Context ctx, Bitmap art) {
        File f = new File(ctx.getFilesDir(), ART_FILE);
        if (art == null) { f.delete(); return; }
        try (FileOutputStream out = new FileOutputStream(f)) {
            Bitmap small = art.getWidth() > 300 ? Bitmap.createScaledBitmap(art, 300, Math.max(1, 300 * art.getHeight() / art.getWidth()), true) : art;
            small.compress(Bitmap.CompressFormat.PNG, 100, out);
        } catch (Exception ignored) {}
    }

    /** Redraw every Murmur widget. */
    static void refresh(Context ctx) {
        AppWidgetManager m = AppWidgetManager.getInstance(ctx);
        for (Class<?> c : new Class<?>[] { MurmurWidget.class, MurmurWidgetSquare.class })
            for (int id : m.getAppWidgetIds(new ComponentName(ctx, c))) draw(ctx, m, id);
    }

    @Override
    public void onUpdate(Context ctx, AppWidgetManager m, int[] ids) {
        for (int id : ids) draw(ctx, m, id);
    }

    @Override
    public void onAppWidgetOptionsChanged(Context ctx, AppWidgetManager m, int id, Bundle opts) {
        draw(ctx, m, id);
    }

    private static void draw(Context ctx, AppWidgetManager m, int id) {
        SharedPreferences p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String title = p.getString("title", ""), artist = p.getString("artist", "");
        boolean playing = p.getBoolean("playing", false) && PlaybackService.running, liked = p.getBoolean("liked", false);
        Bitmap art = null;
        File f = new File(ctx.getFilesDir(), ART_FILE);
        if (f.exists()) try { art = BitmapFactory.decodeFile(f.getPath()); } catch (Exception ignored) {}

        RemoteViews tiny = build(ctx, R.layout.widget_tiny, title, artist, playing, liked, art);
        RemoteViews wide = build(ctx, R.layout.widget_wide, title, artist, playing, liked, art);
        RemoteViews large = build(ctx, R.layout.widget_large, title, artist, playing, liked, art);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // Android 12+: the launcher picks the look that fits as the widget is resized.
            Map<SizeF, RemoteViews> looks = new HashMap<>();
            looks.put(new SizeF(40f, 40f), tiny);
            looks.put(new SizeF(180f, 40f), wide);
            looks.put(new SizeF(150f, 150f), large);
            m.updateAppWidget(id, new RemoteViews(looks));
        } else {
            Bundle o = m.getAppWidgetOptions(id);
            int w = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 250), h = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 60);
            m.updateAppWidget(id, h >= 150 && w >= 150 ? large : w >= 180 ? wide : tiny);
        }
    }

    private static RemoteViews build(Context ctx, int layout, String title, String artist, boolean playing, boolean liked, Bitmap art) {
        RemoteViews v = new RemoteViews(ctx.getPackageName(), layout);
        boolean has = !title.isEmpty();
        if (has(v, layout, R.id.w_title)) v.setTextViewText(R.id.w_title, has ? title : "Murmur");
        if (has(v, layout, R.id.w_artist)) v.setTextViewText(R.id.w_artist, has ? artist : "Tap to open");
        if (art != null) v.setImageViewBitmap(R.id.w_art, art); else v.setImageViewResource(R.id.w_art, R.drawable.w_art_empty);
        v.setImageViewResource(R.id.w_play, playing ? R.drawable.n_pause : R.drawable.n_play);
        v.setContentDescription(R.id.w_play, playing ? "Pause" : "Play");
        // Only the song name opens Murmur. A tap target over the whole widget made the launcher open the app when
        // you let go after holding it to move or resize it.
        if (layout != R.layout.widget_tiny) {
            v.setOnClickPendingIntent(R.id.w_title, openApp(ctx, null, 20));
            v.setOnClickPendingIntent(R.id.w_artist, openApp(ctx, null, 25));
        }
        v.setOnClickPendingIntent(R.id.w_play, button(ctx, "toggle", 21));
        if (layout != R.layout.widget_tiny) {
            v.setOnClickPendingIntent(R.id.w_prev, button(ctx, "prev", 22));
            v.setOnClickPendingIntent(R.id.w_next, button(ctx, "next", 23));
        }
        if (layout == R.layout.widget_large) {
            v.setImageViewResource(R.id.w_like, liked ? R.drawable.n_heart_on : R.drawable.n_heart);
            v.setContentDescription(R.id.w_like, liked ? "Remove from Liked Songs" : "Save to Liked Songs");
            v.setOnClickPendingIntent(R.id.w_like, button(ctx, "like", 24));
            v.setViewVisibility(R.id.w_like, has ? View.VISIBLE : View.GONE);
        }
        return v;
    }

    private static boolean has(RemoteViews v, int layout, int view) {
        return !(layout == R.layout.widget_tiny && (view == R.id.w_title || view == R.id.w_artist));
    }

    /**
     * While Murmur is open (even in the background) the buttons go straight to the player. When it's closed, a tap
     * opens Murmur and does the same thing once it's loaded (Android doesn't let a widget start music on its own).
     */
    private static PendingIntent button(Context ctx, String what, int code) {
        if (!MainActivity.pageAlive()) return openApp(ctx, what, code);
        Intent i = new Intent(ctx, PlaybackService.class).setAction(PlaybackService.ACTION_CONTROL).putExtra("do", what);
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? PendingIntent.getForegroundService(ctx, code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT)
                : PendingIntent.getService(ctx, code, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private static PendingIntent openApp(Context ctx, String what, int code) {
        Intent i = new Intent(ctx, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (what != null) i.putExtra("do", what);
        return PendingIntent.getActivity(ctx, code + 100, i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }
}
