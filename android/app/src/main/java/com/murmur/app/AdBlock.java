package com.murmur.app;

import android.net.Uri;

/**
 * The app's built-in ad blocker. Matches ad servers and YouTube's ad and ad-tracking endpoints.
 * It's best-effort: YouTube changes how it serves ads, so some may still get through.
 * Keep this list in step with the iPhone app (ios/Murmur/AdBlock.swift).
 */
final class AdBlock {
    static volatile int blocked = 0;

    /** Whole sites that only serve ads or ad tracking. */
    private static final String[] AD_HOSTS = {
            "doubleclick.net", "googlesyndication.com", "googleadservices.com", "googletagservices.com",
            "adservice.google.com", "imasdk.googleapis.com", "2mdn.net", "googleads.g.doubleclick.net"
    };

    /** Ad and ad-tracking paths on YouTube's own sites. */
    private static final String[] YT_AD_PATHS = {
            "/pagead/", "/api/stats/ads", "/ptracking", "/get_midroll_", "/pcs/activeview",
            "/ad_data_204", "/api/stats/atr", "/youtubei/v1/player/ad_break"
    };

    private AdBlock() {}

    static boolean isAd(Uri u) {
        String host = u.getHost();
        if (host == null) return false;
        host = host.toLowerCase();
        for (String h : AD_HOSTS) if (host.equals(h) || host.endsWith("." + h)) return true;
        boolean youtube = host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com");
        if (youtube) {
            String path = u.getPath() == null ? "" : u.getPath();
            for (String p : YT_AD_PATHS) if (path.startsWith(p)) return true;
        }
        // Video files themselves (googlevideo.com) are never blocked, so songs always play.
        return false;
    }
}
