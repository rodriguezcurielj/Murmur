package com.murmur.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.View;
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
 * Sign-in, music, YouTube and Spotify all come from the web app; this class adds the
 * phone pieces: file picking for uploads, saving songs to Downloads, the back button,
 * and keeping playback going in the background and across folds.
 */
public class MainActivity extends Activity {
    private static final int PICK_FILES = 1;
    private static final String HOME = BuildConfig.START_URL;
    private static final int BG = Color.parseColor("#120e17");

    private WebView web;
    private ValueCallback<Uri[]> pendingPick;
    private static volatile MainActivity current;

    /** Notification, lock-screen and headphone buttons: pass them to the page ("toggle", "play", "pause", "next", "prev"). */
    static void control(String action) {
        MainActivity a = current;
        if (a == null || a.web == null || action == null) return;
        String safe = action.replaceAll("[^a-z]", "");
        a.runOnUiThread(() -> a.web.evaluateJavascript("window.murmurControl && window.murmurControl('" + safe + "')", null));
    }

    /**
     * A WebView that never tells the page it was hidden. Normally leaving the app marks the page hidden,
     * which pauses media (and YouTube pauses itself); this keeps the music going in the background.
     */
    static class PlayingWebView extends WebView {
        PlayingWebView(android.content.Context c) { super(c); }
        @Override
        protected void onWindowVisibilityChanged(int visibility) {
            if (visibility != View.GONE) super.onWindowVisibilityChanged(View.VISIBLE);
        }
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        Window w = getWindow();
        w.setStatusBarColor(BG);
        w.setNavigationBarColor(BG);

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

        current = this;
        web = new PlayingWebView(this);
        web.setBackgroundColor(BG);
        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                    // sign-in, likes, playlists
        s.setDatabaseEnabled(true);                      // offline downloads (IndexedDB)
        s.setMediaPlaybackRequiresUserGesture(false);    // next song starts on its own
        s.setSupportMultipleWindows(false);
        s.setUserAgentString(s.getUserAgentString() + " MurmurAndroid/1.0");
        CookieManager.getInstance().setAcceptCookie(true);

        web.addJavascriptInterface(new Bridge(), "MurmurAndroid");

        // Ad blocker, part 2: run the ad-removing script inside YouTube's player before YouTube's own code.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            Set<String> youtube = new HashSet<>(Arrays.asList(
                    "https://www.youtube-nocookie.com", "https://www.youtube.com", "https://youtube.com", "https://m.youtube.com"));
            WebViewCompat.addDocumentStartJavaScript(web, YouTubeAdStrip.SCRIPT, youtube);
            // Background play: YouTube's player pauses when it thinks the page is hidden; make it always look visible.
            WebViewCompat.addDocumentStartJavaScript(web, YouTubeAdStrip.ALWAYS_VISIBLE, youtube);
        }

        // Android 13+: ask once to show the "now playing" notification (music keeps playing either way).
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS") != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 2);
        }

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                if (!req.isForMainFrame()) return false;   // frames inside the page (YouTube's player) load normally
                if (staysInApp(u)) return false;
                // YouTube, Google Cloud, Spotify "open song" links etc. open in the phone's browser or app.
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (ActivityNotFoundException e) { /* nothing can open it */ }
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

        web.setWebChromeClient(new WebChromeClient() {
            // "Upload" and "Bring into Murmur": open the phone's file picker.
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (pendingPick != null) pendingPick.onReceiveValue(null);
                pendingPick = callback;
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                i.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"audio/*", "video/*"});
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try {
                    startActivityForResult(i, PICK_FILES);
                } catch (ActivityNotFoundException e) {
                    pendingPick = null;
                    return false;
                }
                return true;
            }
        });

        if (saved != null) web.restoreState(saved);
        else web.loadUrl(HOME);
    }

    /** Murmur itself, its server, and the Spotify sign-in stay inside the app. */
    private static boolean staysInApp(Uri u) {
        String host = u.getHost() == null ? "" : u.getHost();
        String scheme = u.getScheme() == null ? "" : u.getScheme();
        if (scheme.equals("blob") || scheme.equals("data") || scheme.equals("about")) return true;
        return host.equals("rodriguezcurielj.github.io")
                || host.endsWith(".trycloudflare.com")
                || host.endsWith(".ts.net")
                || host.equals("accounts.spotify.com")
                || host.equals("127.0.0.1") || host.equals("localhost");
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

    /** Back gesture: close menus and go back inside Murmur first; leave the app only from Home. */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        web.evaluateJavascript("(window.murmurBack ? window.murmurBack() : false)", handled -> {
            if (!"true".equals(handled)) {
                if (web.canGoBack()) web.goBack();
                else moveTaskToBack(true);   // keep music playing instead of closing
            }
        });
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    // Note: onPause deliberately doesn't pause the WebView, so music keeps playing in the background.

    @Override
    protected void onDestroy() {
        if (current == this) current = null;
        // Closing the app stops the music and its notification.
        if (isFinishing()) startService(new Intent(this, PlaybackService.class).setAction(PlaybackService.ACTION_STOP));
        if (web != null) web.destroy();
        super.onDestroy();
    }

    /** Called from the page as window.MurmurAndroid. */
    private class Bridge {
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
                    target = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                } else {
                    target = getContentResolver().insert(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, v);
                }
                if (target == null) return false;
                try (OutputStream os = getContentResolver().openOutputStream(target)) {
                    if (os == null) return false;
                    os.write(bytes);
                }
                return true;
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "Couldn't save the file", Toast.LENGTH_SHORT).show());
                return false;
            }
        }

        @JavascriptInterface
        public String version() { return "1.4"; }

        @JavascriptInterface
        public int adsBlocked() { return AdBlock.blocked; }

        /** The page reports what's playing; the background service keeps it going and shows the notification. */
        @JavascriptInterface
        public void setPlaying(boolean playing, String title, String artist) {
            PlaybackService.update(getApplicationContext(), playing, title, artist);
        }
    }
}
