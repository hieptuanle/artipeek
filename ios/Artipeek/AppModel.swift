import SwiftUI
import UserNotifications

// The app's state: which server, push on/off, the device token, and what to open.
@MainActor
final class AppModel: ObservableObject {
    static let shared = AppModel()

    @Published private(set) var server: URL?
    @Published var notificationsOn: Bool {
        didSet { UserDefaults.standard.set(notificationsOn, forKey: Keys.notifications) }
    }
    @Published private(set) var deviceToken: String?
    @Published var pushStatus = ""
    @Published var registered = false
    @Published var showSettings = false

    private(set) lazy var web = WebController(model: self)
    private var registering = false

    private enum Keys {
        static let server = "serverURL"
        static let notifications = "notificationsOn"
    }

    init() {
        let d = UserDefaults.standard
        notificationsOn = d.object(forKey: Keys.notifications) as? Bool ?? true
        let saved = d.string(forKey: Keys.server)
        let fallback = Bundle.main.object(forInfoDictionaryKey: "ArtipeekServerHost") as? String
        server = Self.normalize(saved ?? fallback ?? "")
        if server == nil { showSettings = true }
        #if DEBUG
        // Development only: `-openPath /r/<folder>/decisions#d:<folder>:<id>` opens like a tapped push,
        // `-showSettings 1` opens the settings (launch arguments, e.g. `xcrun simctl launch … -openPath …`).
        if let p = d.string(forKey: "openPath") { DispatchQueue.main.async { self.openFromPush(path: p) } }
        if d.bool(forKey: "showSettings") { showSettings = true }
        #endif
    }

    // "artipeek.example.com" or "https://artipeek.example.com/" → https://artipeek.example.com
    nonisolated static func normalize(_ raw: String) -> URL? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return nil }
        if !s.contains("://") { s = "https://" + s }
        guard var c = URLComponents(string: s), let scheme = c.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = c.host, !host.isEmpty else { return nil }
        c.scheme = scheme
        c.path = ""
        c.query = nil
        c.fragment = nil
        return c.url
    }

    // A path from a push ("/r/<folder>/decisions#d:<folder>:<id>") on this server. Only paths: never another site.
    nonisolated static func resolve(path: String?, on server: URL?) -> URL? {
        guard let server, let path, path.hasPrefix("/"), !path.hasPrefix("//") else { return nil }
        return URL(string: server.absoluteString + path)
    }

    func setServer(_ raw: String) -> Bool {
        guard let url = Self.normalize(raw) else { return false }
        if url != server {
            server = url
            UserDefaults.standard.set(url.absoluteString, forKey: Keys.server)
            registered = false
            web.loadStart()
        }
        return true
    }

    // The APNs environment of this build: a development profile says sandbox; TestFlight and App Store builds have no
    // embedded profile and use production.
    nonisolated static var apsEnvironment: String {
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url),
              let text = String(data: data, encoding: .isoLatin1),
              let key = text.range(of: "<key>aps-environment</key>") else { return "production" }
        let rest = text[key.upperBound...]
        guard let a = rest.range(of: "<string>"), let b = rest.range(of: "</string>"), a.upperBound <= b.lowerBound else { return "production" }
        return rest[a.upperBound..<b.lowerBound] == "development" ? "sandbox" : "production"
    }

    // ----- lifecycle -----

    // artipeek's own page finished loading (logged in): ask for push once, register, set the badge.
    func pageReady() {
        if notificationsOn { Task { await enablePush() } }
        Task { await web.refreshBadge() }
    }

    // The login page is showing (first run, or the session ran out): register again after it.
    func loginShown() { registered = false }

    func becameActive() {
        Task { await web.refreshBadge() }
    }

    // ----- push -----

    func enablePush() async {
        let center = UNUserNotificationCenter.current()
        var settings = await center.notificationSettings()
        if settings.authorizationStatus == .notDetermined {
            _ = try? await center.requestAuthorization(options: [.alert, .badge, .sound])
            settings = await center.notificationSettings()
        }
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            UIApplication.shared.registerForRemoteNotifications()
            if deviceToken != nil { await register() }
        case .denied:
            pushStatus = "Notifications are off for artipeek in iOS Settings."
        default:
            break
        }
    }

    func gotDeviceToken(_ hex: String) {
        deviceToken = hex
        if notificationsOn && web.onArtipeekPage { Task { await register() } }
    }

    func register() async {
        guard let token = deviceToken, !registered, !registering, web.onArtipeekPage else { return }
        registering = true
        defer { registering = false }
        let r = await web.postJSON("/_/push/register", [
            "token": token,
            "environment": Self.apsEnvironment,
            "bundle": Bundle.main.bundleIdentifier ?? "",
            "name": UIDevice.current.name,
        ])
        if r.status == 200 {
            registered = true
            pushStatus = "On. This device gets a push for new and urgent decisions."
            if let n = r.body["badge"] as? Int { try? await UNUserNotificationCenter.current().setBadgeCount(n) }
        } else {
            pushStatus = "Not registered: \(r.error)"
        }
    }

    func setNotifications(_ on: Bool) async {
        notificationsOn = on
        if on {
            await enablePush()
        } else {
            await unregister()
            pushStatus = "Off."
        }
    }

    func unregister() async {
        guard let token = deviceToken, web.onArtipeekPage else { registered = false; return }
        _ = await web.postJSON("/_/push/unregister", ["token": token])
        registered = false
    }

    func sendTestPush() async -> String {
        guard let token = deviceToken else { return "No push token yet. Turn notifications on first." }
        guard web.onArtipeekPage else { return "Log in first." }
        if !registered { await register() }
        let r = await web.postJSON("/_/push/test", ["token": token])
        return r.status == 200 ? "Sent. It should arrive in a few seconds." : "Not sent: \(r.error)"
    }

    // Forget the login (cookies and site data) and show the login page again. The push token is removed from the
    // server first, while the login still works.
    func signOut() async {
        await unregister()
        await web.clearData()
        try? await UNUserNotificationCenter.current().setBadgeCount(0)
        pushStatus = ""
        web.loadStart()
    }

    // ----- opening a decision -----

    func openFromPush(path: String?) {
        guard let url = Self.resolve(path: path, on: server) else { return }
        showSettings = false
        web.open(url)
    }
}
