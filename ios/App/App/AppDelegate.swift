import UIKit
import Capacitor
import AVFoundation

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Feishin is a music player, so the WKWebView's HTML5 <audio> must keep
        // playing when the app is backgrounded or the screen locks. Declaring
        // the `.playback` audio-session category plus the `audio`
        // UIBackgroundMode (in Info.plist) lets iOS keep the audio render
        // thread alive in the background; without this iOS suspends the
        // WebView's audio within a few seconds of backgrounding.
        //
        // We set the category but do NOT call setActive(true) here: the WebView
        // activates the session itself when audio actually starts, so doing it
        // at launch would needlessly interrupt whatever else the user is
        // listening to (a podcast, Spotify, …) the moment they open the app.
        // `.playback` is non-mixable, so once Feishin plays it correctly takes
        // over — that's the right behaviour for a music player.
        //
        // Lock-screen / Control Center transport controls are wired separately
        // in the renderer via navigator.mediaSession (see use-media-session.ts)
        // — the @jofr capacitor-media-session plugin is Android-only and is
        // intentionally not part of the iOS build.
        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, options: [])
            print("[ios] AVAudioSession category set to .playback for background audio")
        } catch {
            print("[ios] AVAudioSession .playback setup failed: \(error)")
        }
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
