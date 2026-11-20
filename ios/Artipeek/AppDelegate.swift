import UIKit
import UserNotifications

// Push callbacks: the device token, a push while the app is open, a tap on a push (also from a cold start), and a tap
// on one of its answer buttons (from the iPhone, or the Watch while the phone is locked), which saves the answer in
// the background.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        // keep the categories the extension made, add the fixed ones
        center.getNotificationCategories { cats in center.setNotificationCategories(cats.union(PushCategories.fixed)) }
        WatchLink.shared.start()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor in AppModel.shared.gotDeviceToken(hex) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        Task { @MainActor in AppModel.shared.pushStatus = "Could not get a push token: \(error.localizedDescription)" }
    }

    // In the foreground: show it anyway (banner, sound, badge).
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound, .badge]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let content = response.notification.request.content
        let info = content.userInfo
        let action = response.actionIdentifier
        var text: String?
        if action.hasPrefix("answer.") { text = String(action.dropFirst("answer.".count)) }
        if action == "reply" { text = (response as? UNTextInputNotificationResponse)?.userText.trimmingCharacters(in: .whitespacesAndNewlines) }
        guard let text, let project = info["project"] as? String, let id = info["id"] as? String else {
            if action == "reply" { return } // an empty reply: nothing to send
            let path = info["url"] as? String
            await MainActor.run { AppModel.shared.openFromPush(path: path) }
            return
        }
        guard !text.isEmpty else { return }
        await PushAnswer.send(project: project, id: id, text: text, from: response.notification)
    }
}

// Saves an answer tapped on a push, then says so with a short notification (it shows on the Watch too).
enum PushAnswer {
    static func send(project: String, id: String, text: String, from note: UNNotification) async {
        let center = UNUserNotificationCenter.current()
        let content = note.request.content
        let reply = UNMutableNotificationContent()
        reply.threadIdentifier = content.threadIdentifier
        reply.userInfo = ["url": content.userInfo["url"] ?? "/decisions"]
        let titleLine = content.body.split(separator: "\n").first.map(String.init) ?? ""
        do {
            guard let login = await LoginSync.current() else { throw APIError.noLogin }
            let api = ArtipeekAPI(login)
            try await api.answer(project: project, id: id, text: text, page: "artipeek:push")
            center.removeDeliveredNotifications(withIdentifiers: [note.request.identifier])
            reply.title = "Saved: \(project) · \(id) → \(text)"
            reply.body = titleLine
            if let s = try? await api.list() { try? await center.setBadgeCount(s.open) }
        } catch {
            reply.title = "Not saved: \(project) · \(id) → \(text)"
            reply.body = "\(error.localizedDescription) Tap to answer in artipeek."
            reply.sound = .default
        }
        try? await center.add(UNNotificationRequest(identifier: "artipeek.saved.\(project).\(id)", content: reply, trigger: nil))
    }
}
