package com.murmur.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.MutableContextWrapper;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.window.OnBackInvokedDispatcher;
import android.widget.Toast;

import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.io.ByteArrayInputStream;
import java.io.OutputStream;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * Murmur for Android: a full-screen WebView that opens the Murmur player.
 * Sign-in, music, YouTube and Spotify all come from the web app; this class adds the phone pieces:
 * file picking for uploads, saving songs to Downloads, the back button, background playback,
 * and keeping the page alive when the Razr flips between its big and cover screens.
 */
public class MainActivity extends Activity {
    private static final int PICK_FILES = 1;
    private static final String HOME = BuildConfig.START_URL;
    private static final int BG = Color.parseColor("#120e17");

    /*
     * The WebView outlives the screen it's on. Flipping the Razr (or any screen change Android handles by
     * rebuilding the activity) creates a new MainActivity; the same WebView, with the same page and the
     * same music playing, is moved into it instead of loading Murmur again.
     */
    private static WebView keptWeb;
    private static MutableContextWrapper keptContext;
    private static ValueCallback<Uri[]> pendingPick;
    private static volatile MainActivity current;

    private WebView web;

    /** Notification, lock-screen and headphone buttons: pass them to the page ("toggle", "play", "pause", "next", "prev"). */
    static void control(String action) {
        if (action == null) return;
        String safe = action.replaceAll("[^a-z0-9]", "");
        // The page lives on even when Android has closed the screen behind it, so buttons go straight to it.
        new android.os.Handler(android.os.Looper.getMainLooper()).post(() -> {
            MainActivity a = current;
            WebView w = a != null && a.web != null ? a.web : keptWeb;
            if (w != null) w.evaluateJavascript("window.murmurControl && window.murmurControl('" + safe + "')", null);
        });
    }

    /**
     * A WebView that never tells the page it was hidden. Normally leaving the app marks the page hidden,
     * which pauses media (and YouTube pauses itself); this keeps the music going in the background.
     */
    static class PlayingWebView extends WebView {
        PlayingWebView(Context c) { super(c); }
        @Override
        protected void onWindowVisibilityChanged(int visibility) {
            if (visibility != View.GONE) super.onWindowVisibilityChanged(View.VISIBLE);
        }
    }

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        current = this;
        Window w = getWindow();
        w.setStatusBarColor(BG);
        w.setNavigationBarColor(BG);
        // Use the whole screen, including around camera cutouts (the Razr's cover screen has its cameras in it).
        // The page is padded away from the cutouts below, so nothing ends up under a camera.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            android.view.WindowManager.LayoutParams lp = w.getAttributes();
            lp.layoutInDisplayCutoutMode = android.view.WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS;
            w.setAttributes(lp);
        }

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(BG);
        // Android 15 draws apps under the status and navigation bars; pad the page so nothing hides behind them.
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            } else {
                v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(), insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            }
            return insets;
        });

        if (keptWeb == null) {
            keptContext = new MutableContextWrapper(this);
            keptWeb = createWebView(keptContext);
            keptWeb.loadUrl(HOME);
        } else {
            // Same page, new screen: re-attach it instead of reloading.
            keptContext.setBaseContext(this);
            ViewGroup oldParent = (ViewGroup) keptWeb.getParent();
            if (oldParent != null) oldParent.removeView(keptWeb);
            // New screen: the page re-fits once it's laid out here (see refit and the layout listener).
        }
        web = keptWeb;
        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);

        // Android 13+ (and always on Android 16) delivers the back gesture only to a registered callback;
        // without this, back closes the app instead of going to Murmur's Home.
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        }

        // Android 13+: ask once to show the "now playing" notification (music keeps playing either way).
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 2);
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    private static WebView createWebView(Context ctx) {
        WebView v = new PlayingWebView(ctx);
        v.setBackgroundColor(BG);
        // Press and hold belongs to Murmur (hold a song, then slide to select several), not to Android's text selection.
        v.setOnLongClickListener(x -> true);
        v.setLongClickable(false);

        WebSettings s = v.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                    // sign-in, likes, playlists, where you left off
        s.setDatabaseEnabled(true);                      // offline downloads (IndexedDB)
        s.setMediaPlaybackRequiresUserGesture(false);    // next song starts on its own
        s.setSupportMultipleWindows(false);
        s.setUserAgentString(s.getUserAgentString() + " MurmurAndroid/1.0");
        s.setTextZoom(100);                              // Murmur sizes its own text; a big system font would push the layout off-screen
        s.setUseWideViewPort(true);                      // follow the page's width=device-width
        s.setLoadWithOverviewMode(false);
        CookieManager.getInstance().setAcceptCookie(true);

        v.addJavascriptInterface(new Bridge(ctx.getApplicationContext()), "MurmurAndroid");
        v.addOnLayoutChangeListener((view, l, t, r, b, ol, ot, or, ob) -> {
            if (r - l != or - ol || b - t != ob - ot) refit((WebView) view);
        });

        // Ad blocker, part 2: run the ad-removing script inside YouTube's player before YouTube's own code.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            Set<String> youtube = new HashSet<>(Arrays.asList(
                    "https://www.youtube-nocookie.com", "https://www.youtube.com", "https://youtube.com", "https://m.youtube.com"));
            WebViewCompat.addDocumentStartJavaScript(v, YouTubeAdStrip.SCRIPT, youtube);
            // Background play: YouTube's player pauses when it thinks the page is hidden; make it always look visible.
            WebViewCompat.addDocumentStartJavaScript(v, YouTubeAdStrip.ALWAYS_VISIBLE, youtube);
        }

        v.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (!req.isForMainFrame()) return false;   // frames inside the page (YouTube's player) load normally
                if (staysInApp(u)) return false;
                // YouTube, Google Cloud, Spotify "open song" links, downloads etc. open in the phone's browser or app.
                MainActivity a = current;
                Context c = a != null ? a : view.getContext();
                try {
                    Intent i = new Intent(Intent.ACTION_VIEW, u);
                    if (a == null) i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    c.startActivity(i);
                } catch (ActivityNotFoundException e) { /* nothing can open it */ }
                return true;
            }

            // Built-in ad blocker: ad and ad-tracking requests (including inside YouTube's player) get an empty answer.
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                if (AdBlock.isAd(req.getUrl())) {
                    AdBlock.blocked++;
                    return new WebResourceResponse("text/plain", "utf-8", new ByteArrayInputStream(new byte[0]));
                }
                return null;
            }
        });

        v.setWebChromeClient(new WebChromeClient() {
            // "Upload" and "Bring into Murmur": open the phone's file picker.
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                MainActivity a = current;
                if (a == null) return false;
                if (pendingPick != null) pendingPick.onReceiveValue(null);
                pendingPick = callback;
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                // Use what the page asks for (a profile picture wants images; songs want audio or video).
                java.util.List<String> types = new java.util.ArrayList<>();
                for (String t : params.getAcceptTypes()) {
                    for (String x : t.split(",")) {
                        x = x.trim();
                        if (x.contains("/")) types.add(x);
                    }
                }
                if (types.isEmpty()) { types.add("audio/*"); types.add("video/*"); }
                i.putExtra(Intent.EXTRA_MIME_TYPES, types.toArray(new String[0]));
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try {
                    a.startActivityForResult(i, PICK_FILES);
                } catch (ActivityNotFoundException e) {
                    pendingPick = null;
                    return false;
                }
                return true;
            }
        });
        return v;
    }

    /**
     * Ask the page to size itself for the screen it's on now. Run a few times, because after a flip
     * Android can finish moving the app to the other screen (and change its density) a moment later.
     */
    private static void refit(WebView v) {
        if (v == null) return;
        Runnable fit = () -> v.evaluateJavascript("window.murmurFit && window.murmurFit()", null);
        v.post(fit);
        v.postDelayed(fit, 250);
        v.postDelayed(fit, 800);
    }

    /** Opening the app again (maybe on the other screen): check which screen it's on and fit to it. */
    @Override
    protected void onResume() {
        super.onResume();
        refit(web);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) refit(web);
    }

    /** Murmur itself, its server, and the Spotify sign-in stay inside the app. */
    private static boolean staysInApp(Uri u) {
        String host = u.getHost() == null ? "" : u.getHost();
        String scheme = u.getScheme() == null ? "" : u.getScheme();
        if (scheme.equals("blob") || scheme.equals("data") || scheme.equals("about")) return true;
        // The download page and app files open in the phone's browser, where downloads work.
        String path = u.getPath() == null ? "" : u.getPath();
        if (path.startsWith("/Murmur/apps")) return false;
        return host.equals("rodriguezcurielj.github.io")
                || host.endsWith(".trycloudflare.com")
                || host.endsWith(".ts.net")
                || host.equals("accounts.spotify.com")
                || host.equals("127.0.0.1") || host.equals("localhost");
    }

    /** Changes handled in place (dark mode, keyboard, font): make sure the page re-measures. */
    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        if (web != null) { web.requestLayout(); web.evaluateJavascript("window.dispatchEvent(new Event('resize'))", null); refit(web); }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != PICK_FILES || pendingPick == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                result = new Uri[n];
                for (int k = 0; k < n; k++) result[k] = data.getClipData().getItemAt(k).getUri();
            } else if (data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
        }
        pendingPick.onReceiveValue(result);
        pendingPick = null;
    }

    private long lastBackOnHome = 0;

    /** Older Android sends the back gesture here. Android 13+ uses the callback registered in onCreate. */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() { handleBack(); }

    /**
     * Back gesture: closes whatever is open, otherwise jumps to Murmur's Home. On Home, the first swipe
     * shows "Swipe back again to exit" and a second swipe within 2 seconds leaves the app (music keeps playing).
     */
    private void handleBack() {
        if (web == null) { moveTaskToBack(true); return; }
        web.evaluateJavascript("(window.murmurBack ? window.murmurBack() : false)", handled -> {
            if ("true".equals(handled)) { lastBackOnHome = 0; return; }
            long now = System.currentTimeMillis();
            if (now - lastBackOnHome < 2000) {
                lastBackOnHome = 0;
                moveTaskToBack(true);   // leave the app without closing it, so music keeps playing
            } else {
                lastBackOnHome = now;
                Toast.makeText(this, "Swipe back again to exit", Toast.LENGTH_SHORT).show();
            }
        });
    }

    // Note: onPause deliberately doesn't pause the WebView, so music keeps playing in the background.

    @Override
    protected void onDestroy() {
        // If a newer screen already took over (flip to the other display), this isn't a real close.
        boolean replaced = current != null && current != this;
        if (current == this) current = null;
        if (isFinishing() && !isChangingConfigurations() && !replaced) {
            // Really closing (not a screen change): stop the music and its notification, and let the page go.
            startService(new Intent(this, PlaybackService.class).setAction(PlaybackService.ACTION_STOP));
            if (keptWeb != null) {
                ViewGroup parent = (ViewGroup) keptWeb.getParent();
                if (parent != null) parent.removeView(keptWeb);
                keptWeb.destroy();
                keptWeb = null;
                keptContext = null;
            }
        } else if (keptContext != null) {
            // Being rebuilt for another screen: point the WebView at the app for a moment so this screen can go.
            keptContext.setBaseContext(getApplicationContext());
        }
        super.onDestroy();
    }

    /** Called from the page as window.MurmurAndroid. Uses the app context, so it survives screen changes. */
    private static class Bridge {
        private final Context app;
        Bridge(Context app) { this.app = app; }

        @JavascriptInterface
        public boolean saveFile(String name, String mime, String base64) {
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                v.put(MediaStore.MediaColumns.MIME_TYPE, mime == null || mime.isEmpty() ? "audio/mpeg" : mime);
                Uri target;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/Murmur");
                    target = app.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                } else {
                    target = app.getContentResolver().insert(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, v);
                }
                if (target == null) return false;
                try (OutputStream os = app.getContentResolver().openOutputStream(target)) {
                    if (os == null) return false;
                    os.write(bytes);
                }
                return true;
            } catch (Exception e) {
                MainActivity a = current;
                if (a != null) a.runOnUiThread(() -> Toast.makeText(a, "Couldn't save the file", Toast.LENGTH_SHORT).show());
                return false;
            }
        }

        @JavascriptInterface
        public String version() { return "2.8"; }

        /** Whether Android shows Murmur's "now playing" notification (it can be turned off in the phone's settings). */
        @JavascriptInterface
        public boolean notificationsOn() {
            android.app.NotificationManager nm = app.getSystemService(android.app.NotificationManager.class);
            if (nm == null || !nm.areNotificationsEnabled()) return false;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                android.app.NotificationChannel ch = nm.getNotificationChannel("playback");
                if (ch != null && ch.getImportance() == android.app.NotificationManager.IMPORTANCE_NONE) return false;
            }
            return true;
        }

        /** Opens Murmur's notification settings, to turn the music controls on. */
        @JavascriptInterface
        public void openNotificationSettings() {
            MainActivity a = current;
            Context c = a != null ? a : app;
            Intent i = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                    ? new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, app.getPackageName())
                    : new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + app.getPackageName()));
            if (a == null) i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            try { c.startActivity(i); } catch (Exception ignored) {}
        }

        @JavascriptInterface
        public int adsBlocked() { return AdBlock.blocked; }

        /**
         * Screen info so the page can keep one size everywhere. The Razr's cover screen reports a lower
         * pixel density when Murmur is opened there directly, which shrinks the page; "target" is the
         * highest density Murmur has run at (the inside screen), and the page scales itself up to match.
         */
        @JavascriptInterface
        public String displayInfo() {
            MainActivity a = current;
            if (a == null || a.web == null) return "{}";
            float density = a.getResources().getDisplayMetrics().density;
            android.content.SharedPreferences prefs = app.getSharedPreferences("murmur", Context.MODE_PRIVATE);
            float target = Math.max(prefs.getFloat("targetDensity", 2.625f), density);
            if (target > prefs.getFloat("targetDensity", 0f)) prefs.edit().putFloat("targetDensity", target).apply();
            int width = a.web.getWidth();
            if (width <= 0) width = a.getResources().getDisplayMetrics().widthPixels;
            return "{\"widthPx\":" + width + ",\"density\":" + density + ",\"target\":" + target + "}";
        }

        /** The page reports what's playing; the background service keeps it going and shows the notification. */
        @JavascriptInterface
        public void setPlaying(boolean playing, String title, String artist) {
            PlaybackService.update(app, playing, title, artist);
        }

        /** Newer pages send everything at once (title, artist, album, cover, length, position) as JSON. */
        @JavascriptInterface
        public void setNowPlaying(String json) {
            PlaybackService.updateFull(app, json);
        }
    }
}
