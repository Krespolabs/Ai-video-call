import Foundation

/// One share, as the extension recorded it.
struct SharedShare: Codable {
    enum Kind: String, Codable {
        /// One to three photos. Opens the selfie-to-avatar flow, which fills the
        /// front, left and right slots in that order.
        case photo
        /// A single binary glTF. Opens the upload flow on /create.
        case model
    }

    struct File: Codable {
        let name: String
        let type: String
    }

    let id: String
    let kind: Kind
    let createdAt: Date
    let files: [File]

    /// The page that consumes this share. `inbox` is what tells
    /// src/shared/share-target.js to read from the app rather than from the
    /// service worker's cache, which the iOS WebView does not have.
    var landingPath: String {
        switch kind {
        case .photo: return "/create/selfie?shared=1&inbox=\(id)"
        case .model: return "/create?shared=glb&inbox=\(id)"
        }
    }
}

/// The hand-off between the share extension and the app.
///
/// Android gets this for free: the web manifest's `share_target` makes Chrome
/// POST the files to a service worker. The iOS WebView runs no service worker
/// and has no share target, so the extension writes the files into the App
/// Group container both processes can see, and the app reads them back out
/// through the `ThreeWsApp` plugin when the page asks for them.
///
/// Layout, under the App Group:
///
///     share-inbox/
///       pending              the id of the newest share nobody has opened yet
///       <id>/manifest.json   a SharedShare
///       <id>/0, 1, 2         the files, in the order they were shared
///
/// A share is consumed exactly once: `take` deletes it. The same ten minute
/// window the web hand-off uses bounds how long a share stays claimable, so a
/// photo shared last week cannot resurface the next time the app opens.
enum SharedInbox {
    static let claimWindow: TimeInterval = 10 * 60
    static let retention: TimeInterval = 24 * 60 * 60

    enum InboxError: Error {
        case noContainer
        case empty
    }

    /// `nil` when neither the App Group nor a caches directory is available,
    /// which a correctly signed build never sees.
    static var root: URL? {
        let fm = FileManager.default
        let base: URL?
        if let group = appGroup {
            base = fm.containerURL(forSecurityApplicationGroupIdentifier: group)
        } else {
            // Unsigned development run with no App Group: the extension and the
            // app each get their own container and simply cannot hand off.
            base = fm.urls(for: .cachesDirectory, in: .userDomainMask).first
        }
        return base?.appendingPathComponent("share-inbox", isDirectory: true)
    }

    /// Records a share and marks it as the one the app should open next.
    ///
    /// - Parameter files: each file's bytes already on disk (the extension
    ///   copies them out of the sending app's sandbox first), with the name and
    ///   MIME type the page will see.
    @discardableResult
    static func store(kind: SharedShare.Kind, files: [(source: URL, name: String, type: String)]) throws -> SharedShare {
        guard !files.isEmpty else { throw InboxError.empty }
        guard let root else { throw InboxError.noContainer }
        let fm = FileManager.default
        let id = UUID().uuidString.lowercased()
        let dir = root.appendingPathComponent(id, isDirectory: true)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)

        var entries: [SharedShare.File] = []
        for (index, file) in files.enumerated() {
            let target = dir.appendingPathComponent(String(index))
            try? fm.removeItem(at: target)
            try fm.moveItem(at: file.source, to: target)
            entries.append(SharedShare.File(name: file.name, type: file.type))
        }

        let share = SharedShare(id: id, kind: kind, createdAt: Date(), files: entries)
        try encoder.encode(share).write(to: dir.appendingPathComponent("manifest.json"), options: .atomic)
        try Data(id.utf8).write(to: root.appendingPathComponent("pending"), options: .atomic)
        return share
    }

    /// The share waiting to be opened, if there is a fresh one. Consumes the
    /// marker, so the next activation of the app does not route to it again.
    static func claimPending() -> SharedShare? {
        guard let root else { return nil }
        let marker = root.appendingPathComponent("pending")
        guard let data = try? Data(contentsOf: marker) else { return nil }
        try? FileManager.default.removeItem(at: marker)
        guard let id = String(data: data, encoding: .utf8), let share = manifest(id: id) else { return nil }
        return Date().timeIntervalSince(share.createdAt) <= claimWindow ? share : nil
    }

    /// Reads a share's files and deletes it. `nil` for an unknown, malformed or
    /// expired id: the id arrives from the WebView, so it is validated before
    /// it is ever joined onto a path.
    static func take(id: String) -> (share: SharedShare, files: [Data])? {
        guard isValidId(id), let root, let share = manifest(id: id) else { return nil }
        let dir = root.appendingPathComponent(id, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        guard Date().timeIntervalSince(share.createdAt) <= claimWindow else { return nil }
        var files: [Data] = []
        for index in share.files.indices {
            guard let bytes = try? Data(contentsOf: dir.appendingPathComponent(String(index))) else { return nil }
            files.append(bytes)
        }
        return (share, files)
    }

    /// Deletes every share older than `retention`. Called at launch.
    static func sweep() {
        guard let root else { return }
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: [.creationDateKey]) else { return }
        let cutoff = Date().addingTimeInterval(-retention)
        for entry in entries where entry.lastPathComponent != "pending" {
            let created = (try? entry.resourceValues(forKeys: [.creationDateKey]))?.creationDate ?? .distantPast
            if created < cutoff { try? fm.removeItem(at: entry) }
        }
    }

    static func isValidId(_ id: String) -> Bool {
        UUID(uuidString: id) != nil && id == id.lowercased()
    }

    private static func manifest(id: String) -> SharedShare? {
        guard isValidId(id), let root else { return nil }
        let url = root.appendingPathComponent(id, isDirectory: true).appendingPathComponent("manifest.json")
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? decoder.decode(SharedShare.self, from: data)
    }

    /// The App Group shared with the Agent glance widget. Both targets expand
    /// the `GLANCE_APP_GROUP` build setting into this Info.plist key; a value
    /// starting with a dot means `DEVELOPMENT_TEAM` was unset at build time.
    private static var appGroup: String? {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: "GlanceAppGroup") as? String else { return nil }
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty || value.hasPrefix(".") ? nil : value
    }

    private static var encoder: JSONEncoder {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .secondsSince1970
        return e
    }

    private static var decoder: JSONDecoder {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .secondsSince1970
        return d
    }
}
