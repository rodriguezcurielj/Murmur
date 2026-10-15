import SafariServices

/// Murmur's Safari ad blocker has no native side; Safari needs this class to load the extension.
class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        context.completeRequest(returningItems: [], completionHandler: nil)
    }
}
