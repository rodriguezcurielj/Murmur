import WebKit

/// The app's built-in ad blocker: a WebKit content-blocking rule list that stops ad servers and
/// YouTube's ad and ad-tracking endpoints, including inside YouTube's player. Best-effort; video files
/// themselves are never blocked, so songs always play. Keep in step with android/.../AdBlock.java.
enum AdBlock {
    static let adHosts = [
        "doubleclick.net", "googlesyndication.com", "googleadservices.com", "googletagservices.com",
        "adservice.google.com", "imasdk.googleapis.com", "2mdn.net"
    ]
    static let youtubeAdPaths = [
        "/pagead/", "/api/stats/ads", "/ptracking", "/get_midroll_", "/pcs/activeview",
        "/ad_data_204", "/api/stats/atr", "/youtubei/v1/player/ad_break"
    ]

    /// Only dots need escaping in WebKit's simple rule patterns.
    static func escape(_ s: String) -> String { s.replacingOccurrences(of: ".", with: "\\.") }

    /// WebKit rule-list JSON (plain patterns only, since WebKit supports a small subset of regex).
    static var rulesJSON: String {
        var filters: [String] = adHosts.map { escape($0) + "/" }
        for site in ["youtube.com", "youtube-nocookie.com"] {
            for path in youtubeAdPaths { filters.append(escape(site) + escape(path)) }
        }
        let rules = filters.map { ["trigger": ["url-filter": $0], "action": ["type": "block"]] }
        let data = (try? JSONSerialization.data(withJSONObject: rules)) ?? Data("[]".utf8)
        return String(data: data, encoding: .utf8) ?? "[]"
    }

    /// Runs inside YouTube's player and removes the ad entries from the data YouTube sends it
    /// (same idea as uBlock Origin's "json-prune" rule). Keep in step with android/.../YouTubeAdStrip.java.
    static let youtubeScript = """
    (function () {
      if (!/(^|\\.)youtube(-nocookie)?\\.com$/.test(location.hostname)) return;
      if (window.__murmurAdStrip) return; window.__murmurAdStrip = true;
      var KEYS = ['adPlacements', 'playerAds', 'adSlots', 'adBreakHeartbeatParams', 'adBreakParams'];
      function strip(o, depth) {
        try {
          if (!o || typeof o !== 'object' || (depth || 0) > 4) return o;
          if (Array.isArray(o)) { for (var i = 0; i < o.length; i++) strip(o[i], (depth || 0) + 1); return o; }
          for (var k = 0; k < KEYS.length; k++) if (KEYS[k] in o) delete o[KEYS[k]];
          if (o.playerResponse) strip(o.playerResponse, (depth || 0) + 1);
          if (o.response) strip(o.response, (depth || 0) + 1);
        } catch (e) {}
        return o;
      }
      var parse = JSON.parse;
      JSON.parse = function () { return strip(parse.apply(this, arguments)); };
      if (window.Response && Response.prototype.json) {
        var json = Response.prototype.json;
        Response.prototype.json = function () { return json.apply(this, arguments).then(function (v) { return strip(v); }); };
      }
      var initial;
      try {
        Object.defineProperty(window, 'ytInitialPlayerResponse', {
          configurable: true,
          get: function () { return initial; },
          set: function (v) { initial = strip(v); }
        });
      } catch (e) {}
    })();
    """

    /// Compiles the rules once and adds them to the web view's configuration, then calls `done`.
    static func install(into controller: WKUserContentController, done: @escaping () -> Void) {
        // Runs in every frame, including YouTube's player; the script itself only acts on YouTube pages.
        controller.addUserScript(WKUserScript(source: youtubeScript, injectionTime: .atDocumentStart, forMainFrameOnly: false))
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "murmur-adblock-1", encodedContentRuleList: rulesJSON) { list, _ in
            if let list = list { controller.add(list) }
            done()
        }
    }
}
