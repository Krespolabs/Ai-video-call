import UIKit
import Capacitor

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        // MainViewController, not Capacitor's stock CAPBridgeViewController.
        // Building the window here replaces whatever Main.storyboard names, so
        // this line is the only thing that decides which controller hosts the
        // WebView. With the stock class the app silently loses edge-swipe back,
        // the dark chrome, the CarPlay channel and the ThreeWsApp plugin.
        let main = MainViewController()
        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = main
        window?.makeKeyAndVisible()

        // A cold launch straight from the widget link on three.ws/glance. The
        // token is claimed here so it never reaches the WebView; the URL is
        // still handed on, and native-bridge.js drops it for the same reason.
        for context in connectionOptions.urlContexts {
            GlanceLink.claim(context.url)
        }

        // A cold launch from a home screen quick action. The WebView has just
        // started loading the start URL; loading the action's page instead
        // replaces that navigation rather than stacking a second one on it.
        if let item = connectionOptions.shortcutItem {
            QuickActions.perform(item, in: main)
        }

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        // threews://glance/link?token=glw_... hands the home screen widget its
        // own revocable credential. It is stored in the shared keychain and the
        // widget's timelines are reloaded; anything else falls through to
        // Capacitor, which is what routes wallet and OAuth returns.
        let unclaimed = URLContexts.filter { GlanceLink.claim($0.url) == .notALinkURL }
        guard !unclaimed.isEmpty else { return }
        SceneDelegateProxy.shared.scene(scene, openURLContexts: unclaimed)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }

    /// A quick action chosen while the app was already running.
    func windowScene(_ windowScene: UIWindowScene,
                     performActionFor shortcutItem: UIApplicationShortcutItem,
                     completionHandler: @escaping (Bool) -> Void) {
        guard let main = window?.rootViewController as? MainViewController else {
            completionHandler(false)
            return
        }
        completionHandler(QuickActions.perform(shortcutItem, in: main))
    }

    /// Picks up a photo or model shared from another app.
    ///
    /// The share extension cannot open the app itself (Apple withholds
    /// `UIApplication.open` from extensions), so it parks the files in the App
    /// Group and the app collects them the next time it comes forward, which is
    /// what the sheet tells the user to do. `claimPending` consumes the marker,
    /// so a share is routed exactly once however often the app is activated.
    func sceneDidBecomeActive(_ scene: UIScene) {
        guard let main = window?.rootViewController as? MainViewController,
              let share = SharedInbox.claimPending()
        else { return }
        main.open(path: share.landingPath)
    }
}
