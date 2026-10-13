package com.murmur.app;

/**
 * Script that runs inside YouTube's player (not in Murmur's page). YouTube tells its player which ads
 * to play in the same data that describes the video; this removes those ad entries as the player reads
 * them, so there's nothing to play. Same idea as uBlock Origin's "json-prune" rule for YouTube.
 * Keep in step with ios/Murmur/AdBlock.swift (youtubeScript).
 */
final class YouTubeAdStrip {
    private YouTubeAdStrip() {}

    static final String SCRIPT =
            "(function () {\n" +
            "  if (window.__murmurAdStrip) return; window.__murmurAdStrip = true;\n" +
            "  var KEYS = ['adPlacements', 'playerAds', 'adSlots', 'adBreakHeartbeatParams', 'adBreakParams'];\n" +
            "  function strip(o, depth) {\n" +
            "    try {\n" +
            "      if (!o || typeof o !== 'object' || (depth || 0) > 4) return o;\n" +
            "      if (Array.isArray(o)) { for (var i = 0; i < o.length; i++) strip(o[i], (depth || 0) + 1); return o; }\n" +
            "      for (var k = 0; k < KEYS.length; k++) if (KEYS[k] in o) delete o[KEYS[k]];\n" +
            "      if (o.playerResponse) strip(o.playerResponse, (depth || 0) + 1);\n" +
            "      if (o.response) strip(o.response, (depth || 0) + 1);\n" +
            "    } catch (e) {}\n" +
            "    return o;\n" +
            "  }\n" +
            "  var parse = JSON.parse;\n" +
            "  JSON.parse = function () { return strip(parse.apply(this, arguments)); };\n" +
            "  if (window.Response && Response.prototype.json) {\n" +
            "    var json = Response.prototype.json;\n" +
            "    Response.prototype.json = function () { return json.apply(this, arguments).then(function (v) { return strip(v); }); };\n" +
            "  }\n" +
            "  var initial;\n" +
            "  try {\n" +
            "    Object.defineProperty(window, 'ytInitialPlayerResponse', {\n" +
            "      configurable: true,\n" +
            "      get: function () { return initial; },\n" +
            "      set: function (v) { initial = strip(v); }\n" +
            "    });\n" +
            "  } catch (e) {}\n" +
            "})();";
}
