import UIKit
import UniformTypeIdentifiers
import UserNotifications

/// The three.ws entry in the system share sheet.
///
/// Share one to three photos and they become the front, left and right angles
/// of a selfie-to-avatar run; share a `.glb` and it lands in the upload flow.
/// This is the iOS counterpart of the Android app's web share target, and it
/// accepts the same things (solana-mobile/twa/twa-manifest.json `shareTarget`).
///
/// The extension does the part only it can do, copying the files out of the
/// sending app while it still has access to them, and nothing else. Photos are
/// normalised to JPEG here because the page's pipeline reads JPEG, PNG and
/// WebP, and an iPhone photo arrives as HEIC.
final class ShareViewController: UIViewController {
    /// Longest edge of a shared photo. Matches what /create/selfie downsizes to
    /// before upload, so nothing is lost and the hand-off stays small.
    private static let maxPhotoEdge: CGFloat = 2048
    /// The page receives the model as one base64 string across the Capacitor
    /// bridge, which roughly doubles it in memory. Past this an older phone's
    /// WebView process is at risk of being killed mid hand-off.
    private static let maxModelBytes = 64 * 1024 * 1024
    private static let glbType = "org.khronos.glb"

    private let card = UIView()
    private let preview = UIImageView()
    private let titleLabel = UILabel()
    private let statusLabel = UILabel()
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let doneButton = UIButton(type: .system)
    /// Scratch space for copies on their way into the inbox. A stored share has
    /// already moved its files out; whatever a failed one left is deleted.
    private lazy var staging = FileManager.default.temporaryDirectory
        .appendingPathComponent(UUID().uuidString, isDirectory: true)

    override func viewDidLoad() {
        super.viewDidLoad()
        buildInterface()
        collect()
    }

    // MARK: - Collecting

    private enum Outcome {
        case stored(SharedShare)
        case failed(String)
    }

    private func collect() {
        let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? [])
            .flatMap { $0.attachments ?? [] }
        let models = providers.filter(isModel)
        let photos = providers.filter { !isModel($0) && $0.hasItemConformingToTypeIdentifier(UTType.image.identifier) }

        try? FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)

        if let model = models.first {
            loadModel(model, into: staging) { [weak self] outcome in self?.finish(outcome) }
        } else if !photos.isEmpty {
            loadPhotos(Array(photos.prefix(3)), into: staging) { [weak self] outcome in self?.finish(outcome) }
        } else {
            finish(.failed("three.ws takes photos and .glb models. This item is neither."))
        }
    }

    private func isModel(_ provider: NSItemProvider) -> Bool {
        if provider.hasItemConformingToTypeIdentifier(Self.glbType) { return true }
        return provider.suggestedName?.lowercased().hasSuffix(".glb") == true
    }

    private func loadPhotos(_ providers: [NSItemProvider], into staging: URL, completion: @escaping (Outcome) -> Void) {
        // The providers call back on arbitrary queues, so every write to the
        // slots goes through one lock. Order is kept by index, not by arrival:
        // the first photo shared is the one that becomes the front view.
        var slots = [URL?](repeating: nil, count: providers.count)
        let lock = NSLock()
        let group = DispatchGroup()
        for (index, provider) in providers.enumerated() {
            group.enter()
            provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in
                defer { group.leave() }
                guard let data, let jpeg = Self.normalisedJPEG(data) else { return }
                let url = staging.appendingPathComponent("photo-\(index).jpg")
                guard (try? jpeg.write(to: url, options: .atomic)) != nil else { return }
                lock.lock()
                slots[index] = url
                lock.unlock()
            }
        }
        group.notify(queue: .main) {
            let files = slots.enumerated().compactMap { index, url in
                url.map { (source: $0, name: "shared-photo-\(index + 1).jpg", type: "image/jpeg") }
            }
            guard !files.isEmpty else {
                completion(.failed("That photo could not be read. Try saving it to Photos and sharing it from there."))
                return
            }
            completion(Self.store(.photo, files))
        }
    }

    private func loadModel(_ provider: NSItemProvider, into staging: URL, completion: @escaping (Outcome) -> Void) {
        let type = provider.hasItemConformingToTypeIdentifier(Self.glbType) ? Self.glbType : UTType.data.identifier
        let name = Self.modelName(provider.suggestedName)
        provider.loadFileRepresentation(forTypeIdentifier: type) { url, _ in
            // The URL is only valid inside this callback, so the copy happens here.
            var outcome: Outcome = .failed("That model could not be read. Try sharing it again.")
            if let url {
                let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize ?? 0
                let target = staging.appendingPathComponent("model.glb")
                if size > Self.maxModelBytes {
                    outcome = .failed("That model is over 64 MB. Upload it from three.ws/create on a computer instead.")
                } else if (try? FileManager.default.copyItem(at: url, to: target)) != nil, Self.hasGlbMagic(target) {
                    outcome = Self.store(.model, [(source: target, name: name, type: "model/gltf-binary")])
                } else {
                    outcome = .failed("That file is not a binary glTF (.glb) model.")
                }
            }
            DispatchQueue.main.async { completion(outcome) }
        }
    }

    private static func store(_ kind: SharedShare.Kind, _ files: [(source: URL, name: String, type: String)]) -> Outcome {
        do {
            return .stored(try SharedInbox.store(kind: kind, files: files))
        } catch {
            return .failed("three.ws could not save this share. Open the app once, then try again.")
        }
    }

    /// Decodes any image iOS can read (HEIC, PNG, WebP, RAW previews) and
    /// re-encodes it as an upright JPEG no larger than `maxPhotoEdge`.
    private static func normalisedJPEG(_ data: Data) -> Data? {
        guard let image = UIImage(data: data) else { return nil }
        let longest = max(image.size.width, image.size.height)
        guard longest > 0 else { return nil }
        let scale = min(1, maxPhotoEdge / longest)
        let size = CGSize(width: floor(image.size.width * scale), height: floor(image.size.height * scale))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let rendered = UIGraphicsImageRenderer(size: size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        return rendered.jpegData(compressionQuality: 0.9)
    }

    private static func hasGlbMagic(_ url: URL) -> Bool {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return false }
        defer { try? handle.close() }
        return (try? handle.read(upToCount: 4)) == Data("glTF".utf8)
    }

    private static func modelName(_ suggested: String?) -> String {
        let base = (suggested ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !base.isEmpty else { return "shared-model.glb" }
        return base.lowercased().hasSuffix(".glb") ? base : "\(base).glb"
    }

    // MARK: - Finishing

    private func finish(_ outcome: Outcome) {
        try? FileManager.default.removeItem(at: staging)
        spinner.stopAnimating()
        doneButton.isEnabled = true
        switch outcome {
        case .stored(let share):
            titleLabel.text = share.kind == .photo ? "Photo ready" : "Model ready"
            statusLabel.text = share.kind == .photo
                ? "Open three.ws and it will be waiting in Create, ready to become a 3D avatar."
                : "Open three.ws and it will be waiting in Create, ready to upload."
            doneButton.setTitle("Done", for: .normal)
            remind(about: share)
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        case .failed(let message):
            titleLabel.text = "Could not share"
            statusLabel.text = message
            doneButton.setTitle("Close", for: .normal)
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        }
        UIAccessibility.post(notification: .announcement, argument: statusLabel.text)
    }

    /// A tappable way back into the app, for someone who already allowed
    /// three.ws notifications. Never asks: a permission prompt from inside a
    /// share sheet is the wrong moment and App Review agrees.
    private func remind(about share: SharedShare) {
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized else { return }
            let content = UNMutableNotificationContent()
            content.title = share.kind == .photo ? "Your photo is ready" : "Your model is ready"
            content.body = share.kind == .photo ? "Tap to turn it into a 3D avatar." : "Tap to upload it to three.ws."
            content.threadIdentifier = "share"
            let request = UNNotificationRequest(identifier: "share-\(share.id)", content: content,
                                                trigger: UNTimeIntervalNotificationTrigger(timeInterval: 1, repeats: false))
            center.add(request)
        }
    }

    @objc private func close() {
        extensionContext?.completeRequest(returningItems: nil)
    }

    // MARK: - Interface

    private func buildInterface() {
        let ink = UIColor(red: 0x08 / 255.0, green: 0x08 / 255.0, blue: 0x14 / 255.0, alpha: 1)
        view.backgroundColor = UIColor.black.withAlphaComponent(0.35)

        card.backgroundColor = ink
        card.layer.cornerRadius = 20
        card.layer.cornerCurve = .continuous
        card.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(card)

        let mark = UIImageView(image: UIImage(systemName: "cube.transparent"))
        mark.tintColor = .white
        mark.contentMode = .scaleAspectFit
        mark.accessibilityLabel = "three.ws"

        titleLabel.text = "Preparing"
        titleLabel.font = .preferredFont(forTextStyle: .headline)
        titleLabel.adjustsFontForContentSizeCategory = true
        titleLabel.textColor = .white

        statusLabel.text = "Copying from the app you shared from."
        statusLabel.font = .preferredFont(forTextStyle: .subheadline)
        statusLabel.adjustsFontForContentSizeCategory = true
        statusLabel.textColor = UIColor.white.withAlphaComponent(0.72)
        statusLabel.numberOfLines = 0

        spinner.color = .white
        spinner.startAnimating()

        var config = UIButton.Configuration.filled()
        config.cornerStyle = .large
        config.baseBackgroundColor = .white
        config.baseForegroundColor = ink
        doneButton.configuration = config
        doneButton.setTitle("Please wait", for: .normal)
        doneButton.isEnabled = false
        doneButton.addTarget(self, action: #selector(close), for: .touchUpInside)

        let header = UIStackView(arrangedSubviews: [mark, titleLabel, UIView(), spinner])
        header.spacing = 10
        header.alignment = .center

        let stack = UIStackView(arrangedSubviews: [header, statusLabel, doneButton])
        stack.axis = .vertical
        stack.spacing = 16
        stack.translatesAutoresizingMaskIntoConstraints = false
        card.addSubview(stack)

        let fillMargins = card.widthAnchor.constraint(equalTo: view.layoutMarginsGuide.widthAnchor)
        fillMargins.priority = .defaultHigh

        NSLayoutConstraint.activate([
            mark.widthAnchor.constraint(equalToConstant: 26),
            mark.heightAnchor.constraint(equalToConstant: 26),
            doneButton.heightAnchor.constraint(greaterThanOrEqualToConstant: 48),
            // Full width on a phone, a 420pt card centred on an iPad: the width
            // cap wins over the margins because the margin fit is only preferred.
            card.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            card.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            card.widthAnchor.constraint(lessThanOrEqualToConstant: 420),
            card.leadingAnchor.constraint(greaterThanOrEqualTo: view.layoutMarginsGuide.leadingAnchor),
            fillMargins,
            stack.topAnchor.constraint(equalTo: card.topAnchor, constant: 22),
            stack.leadingAnchor.constraint(equalTo: card.leadingAnchor, constant: 22),
            stack.trailingAnchor.constraint(equalTo: card.trailingAnchor, constant: -22),
            stack.bottomAnchor.constraint(equalTo: card.bottomAnchor, constant: -22),
        ])
    }
}
