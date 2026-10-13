import UIKit
import WebKit

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
          version: function () { return 'ios-1.0'; }
        };
        """
        config.userContentController.addUserScript(WKUserScript(source: bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.add(self, name: "saveFile")

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

        web.load(URLRequest(url: Self.startURL))
    }

    /// Murmur, its server and the Spotify sign-in stay inside the app; everything else opens in Safari or its own app.
    static func staysInApp(_ url: URL) -> Bool {
        if ["blob", "data", "about"].contains(url.scheme ?? "") { return true }
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

    /// "Save file to device": write the song to a temporary file and offer the share sheet (Save to Files, AirDrop...).
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
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
