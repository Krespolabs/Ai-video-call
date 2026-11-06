import UIKit
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Shares older than a day were abandoned (the user never came back to
        // the app). Their files are in the shared App Group, which is backed
        // up and counted against the user's storage, so they do not linger.
        SharedInbox.sweep()
        return true
    }

    // APNs hands the device token to the app delegate and to nothing else.
    // The PushNotifications plugin listens for these two Capacitor
    // notifications; without the forwarding, `register()` in the WebView never
    // resolves and the device is never enrolled for push. The web half that
    // sends the token to /api/push/device is src/push-notifications.js.
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        // CarPlay connects as its own scene with its own delegate. Without this
        // branch the car screen would try to build the phone's WebView scene,
        // which CarPlay refuses, and three.ws Drive would simply never appear.
        // See ios/docs/CARPLAY.md and CarPlaySceneDelegate.swift.
        if connectingSceneSession.role == UISceneSession.Role.carTemplateApplication {
            let config = UISceneConfiguration(name: "CarPlay Configuration",
                                              sessionRole: connectingSceneSession.role)
            config.delegateClass = CarPlaySceneDelegate.self
            return config
        }

        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
