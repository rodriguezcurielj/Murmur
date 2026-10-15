import UIKit
import WebKit
import MediaPlayer

/// Murmur for iPhone: a full-screen web view that opens the Murmur player.
/// Sign-in, music, YouTube and Spotify all come from the web app; this adds the phone pieces:
/// background audio, links that leave the app, and "Save file to device" through the share sheet.
final class MurmurViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    /// The GitHub Pages copy, which finds your server through config.js.
    static let startURL = URL(string: "https://rodriguezcurielj.github.io/Murmur/")!
    static let background = UIColor(red: 0x12 / 255.0, green: 0x0E / 255.0, blue: 0x17 / 255.0, alpha: 1)

    private var web: WKWebView!

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = Self.background

        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []    // the next song starts on its own
        config.websiteDataStore = .default()                     // keeps sign-in, likes and downloads
        config.applicationNameForUserAgent = "MurmurIOS/1.0"

        // The page calls window.MurmurAndroid.saveFile(...) to save songs; on iPhone that opens the share sheet.
        let bridge = """
        window.MurmurAndroid = {
          saveFile: function (name, mime, data) {
            window.webkit.messageHandlers.saveFile.postMessage({ name: name, mime: mime, data: data });
            return true;
          },
          setNowPlaying: function (json) { window.webkit.messageHandlers.nowPlaying.postMessage(json); },
          version: function () { return 'ios-1.5'; }
        };
        """
        config.userContentController.addUserScript(WKUserScript(source: bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.add(self, name: "saveFile")
        config.userContentController.add(self, name: "nowPlaying")

        web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = Self.background
        web.scrollView.backgroundColor = Self.background
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.navigationDelegate = self
        web.uiDelegate = self
        if #available(iOS 16.4, *) { web.isInspectable = true }

        web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web)
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            web.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor)
        ])

        setUpRemoteCommands()

        // Turn on the built-in ad blocker before the first page loads.
        AdBlock.install(into: config.userContentController) { [weak self] in
            guard let self = self else { return }
            self.web.load(URLRequest(url: Self.startURL))
        }
    }

    /// Murmur, its server and the Spotify sign-in stay inside the app; everything else opens in Safari or its own app.
    static func staysInApp(_ url: URL) -> Bool {
        if ["blob", "data", "about"].contains(url.scheme ?? "") { return true }
        // The download page and app files open in Safari, where downloads work.
        if url.path.hasPrefix("/Murmur/apps") { return false }
        let host = url.host ?? ""
        return host == "rodriguezcurielj.github.io"
            || host.hasSuffix(".trycloudflare.com")
            || host.hasSuffix(".ts.net")
            || host == "accounts.spotify.com"
            || host == "127.0.0.1" || host == "localhost"
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.allow) }
        // Frames inside the page (YouTube's player) load normally.
        if let frame = action.targetFrame, !frame.isMainFrame { return decisionHandler(.allow) }
        if Self.staysInApp(url) { return decisionHandler(.allow) }
        UIApplication.shared.open(url)
        decisionHandler(.cancel)
    }

    /// Links that ask for a new window (target="_blank").
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if Self.staysInApp(url) { webView.load(action.request) } else { UIApplication.shared.open(url) }
        }
        return nil
    }

    /// If iOS stops the page in the background to save memory, reload it.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    // MARK: Lock screen and Control Center

    /// The lock-screen, Control Center and headphone buttons call back into the page.
    private func setUpRemoteCommands() {
        let c = MPRemoteCommandCenter.shared()
        let send: (String) -> Void = { [weak self] action in
            self?.web?.evaluateJavaScript("window.murmurControl && window.murmurControl('\(action)')", completionHandler: nil)
        }
        c.playCommand.addTarget { _ in send("play"); return .success }
        c.pauseCommand.addTarget { _ in send("pause"); return .success }
        c.togglePlayPauseCommand.addTarget { _ in send("toggle"); return .success }
        c.nextTrackCommand.addTarget { _ in send("next"); return .success }
        c.previousTrackCommand.addTarget { _ in send("prev"); return .success }
        c.changePlaybackPositionCommand.addTarget { e in
            guard let e = e as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            send("seek\(Int(max(0, e.positionTime) * 1000))")
            return .success
        }
    }

    private var artURL = ""
    private var artwork: MPMediaItemArtwork?

    /// The page reports the song, cover and progress (JSON, lengths in milliseconds).
    private func showNowPlaying(_ json: String) {
        guard let data = json.data(using: .utf8),
              let d = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
        let playing = d["playing"] as? Bool ?? false
        let speed = (d["speed"] as? NSNumber)?.doubleValue ?? 1
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: d["title"] as? String ?? "",
            MPMediaItemPropertyArtist: d["artist"] as? String ?? "",
            MPMediaItemPropertyAlbumTitle: d["album"] as? String ?? "",
            MPNowPlayingInfoPropertyPlaybackRate: playing ? speed : 0.0
        ]
        if let ms = (d["duration"] as? NSNumber)?.doubleValue, ms > 0 { info[MPMediaItemPropertyPlaybackDuration] = ms / 1000 }
        if let ms = (d["position"] as? NSNumber)?.doubleValue { info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = ms / 1000 }
        let art = d["art"] as? String ?? ""
        if art != artURL { artURL = art; artwork = nil; loadArtwork(art) }
        if let a = artwork { info[MPMediaItemPropertyArtwork] = a }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        if #available(iOS 13.0, *) { MPNowPlayingInfoCenter.default().playbackState = playing ? .playing : .paused }
    }

    private func loadArtwork(_ url: String) {
        let done: (UIImage?) -> Void = { [weak self] img in
            DispatchQueue.main.async {
                guard let self = self, let img = img, url == self.artURL else { return }
                let a = MPMediaItemArtwork(boundsSize: img.size) { _ in img }
                self.artwork = a
                var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
                info[MPMediaItemPropertyArtwork] = a
                MPNowPlayingInfoCenter.default().nowPlayingInfo = info
            }
        }
        if url.hasPrefix("data:"), let comma = url.firstIndex(of: ","), let data = Data(base64Encoded: String(url[url.index(after: comma)...])) {
            done(UIImage(data: data))
        } else if url.hasPrefix("https://"), let u = URL(string: url) {
            URLSession.shared.dataTask(with: u) { data, _, _ in done(data.flatMap { UIImage(data: $0) }) }.resume()
        }
    }

    /// Messages from the page: "Save file to device", and what's playing.
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "nowPlaying", let json = message.body as? String { showNowPlaying(json); return }
        // "Save file to device": write the song to a temporary file and offer the share sheet (Save to Files, AirDrop...).
        guard message.name == "saveFile",
              let body = message.body as? [String: Any],
              let name = body["name"] as? String,
              let base64 = body["data"] as? String,
              let data = Data(base64Encoded: base64) else { return }
        let safeName = name.replacingOccurrences(of: "/", with: "-")
        let file = FileManager.default.temporaryDirectory.appendingPathComponent(safeName)
        do { try data.write(to: file, options: .atomic) } catch { return }
        let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = view
        sheet.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
        present(sheet, animated: true)
    }
}
