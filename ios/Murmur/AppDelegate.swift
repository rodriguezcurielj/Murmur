import UIKit
import AVFoundation

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // "Playback" keeps your own songs playing when the screen locks or you switch apps
        // (Info.plist also declares the audio background mode).
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
        try? AVAudioSession.sharedInstance().setActive(true)

        let w = UIWindow(frame: UIScreen.main.bounds)
        w.rootViewController = MurmurViewController()
        w.makeKeyAndVisible()
        window = w
        return true
    }
}
