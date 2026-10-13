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

    /// Compiles the rules once and adds them to the web view's configuration, then calls `done`.
    static func install(into controller: WKUserContentController, done: @escaping () -> Void) {
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "murmur-adblock-1", encodedContentRuleList: rulesJSON) { list, _ in
            if let list = list { controller.add(list) }
            done()
        }
    }
}
