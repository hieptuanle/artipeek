import UserNotifications

// Runs before a push shows. A decision whose option values have no fixed category (e.g. 1/2, R/G) gets one made for it,
// with the options' labels on the buttons ("1 · Ship Friday"). The usual sets (A/B…) keep their fixed letter buttons,
// which the Watch shows reliably. If anything here fails, the push shows as it came (Reply… and Open).
final class NotificationService: UNNotificationServiceExtension {
    private var handler: ((UNNotificationContent) -> Void)?
    private var content: UNMutableNotificationContent?
    private static let keep = 30 // made categories kept (one per recent decision)

    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        handler = contentHandler
        guard let c = request.content.mutableCopy() as? UNMutableNotificationContent else { return contentHandler(request.content) }
        content = c
        let info = c.userInfo
        guard c.categoryIdentifier == "artipeek.reply",
              let project = info["project"] as? String, let id = info["id"] as? String,
              let options = info["options"] as? [[String: Any]], !options.isEmpty, options.count <= 4 else { return contentHandler(c) }
        let actions = options.compactMap { o -> UNNotificationAction? in
            guard let v = o["value"] as? String, let l = o["label"] as? String else { return nil }
            return PushCategories.answer(v, title: "\(v)\((o["recommended"] as? Bool) == true ? " ★" : "") · \(l)")
        } + [PushCategories.reply, PushCategories.open]
        let made = UNNotificationCategory(identifier: "artipeek.d.\(project).\(id)", actions: actions, intentIdentifiers: [])
        let center = UNUserNotificationCenter.current()
        center.getNotificationCategories { cats in
            let others = cats.filter { !$0.identifier.hasPrefix("artipeek.d.") }
            let older = cats.filter { $0.identifier.hasPrefix("artipeek.d.") && $0.identifier != made.identifier }.prefix(Self.keep - 1)
            center.setNotificationCategories(others.union(PushCategories.fixed).union(older).union([made]))
            // registering is asynchronous: read them back before the push shows, so the new category exists
            center.getNotificationCategories { _ in
                c.categoryIdentifier = made.identifier
                contentHandler(c)
            }
        }
    }

    override func serviceExtensionTimeWillExpire() {
        if let handler, let content { handler(content) }
    }
}
