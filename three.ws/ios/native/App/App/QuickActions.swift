import UIKit

/// The home screen quick actions: press and hold the three.ws icon.
///
/// They are declared statically in Info.plist (`UIApplicationShortcutItems`) so
/// they exist from the moment the app is installed, before it has ever been
/// opened, and they mirror the Android app's launcher shortcuts in
/// solana-mobile/twa/twa-manifest.json one for one, so the two apps offer the
/// same three doors. The `type` of each item is the only thing read here; the
/// title and icon live in the plist where iOS localises them.
enum QuickActions {
    /// `UIApplicationShortcutItemType` values and the page each one opens. The
    /// `utm_source` keeps quick-action traffic distinguishable in analytics
    /// from an ordinary launch, the same way the Android shortcuts are tagged.
    static let routes: [String: String] = [
        "ws.three.app.create": "/create?utm_source=ios_shortcut",
        "ws.three.app.discover": "/marketplace?utm_source=ios_shortcut",
        "ws.three.app.agents": "/my-agents?utm_source=ios_shortcut",
        "ws.three.app.notifications": "/notifications?utm_source=ios_shortcut",
    ]

    /// Opens the page for `item`. Returns false for a type this build does not
    /// know, which is what an item left behind by an older build would be.
    @discardableResult
    static func perform(_ item: UIApplicationShortcutItem, in controller: MainViewController) -> Bool {
        guard let path = routes[item.type] else { return false }
        controller.open(path: path)
        return true
    }
}
