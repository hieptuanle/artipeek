import UserNotifications

// Buttons on artipeek's pushes. The server picks a category: a fixed one for the usual option values (letter buttons,
// shown on the Watch too), or "artipeek.reply". The notification extension may add a category with the options' labels.
// Button ids: "answer.<value>", "reply" (typed, dictated or scribbled answer), "open".
enum PushCategories {
    static let fixedValueSets = ["AB", "ABC", "ABCD", "YN"] // must match push/notify.ts
    static let reply = UNTextInputNotificationAction(identifier: "reply", title: "Reply…", options: [.authenticationRequired],
                                                     textInputButtonTitle: "Send", textInputPlaceholder: "A, or your own answer")
    static let open = UNNotificationAction(identifier: "open", title: "Open", options: [.foreground])

    static func answer(_ value: String, title: String) -> UNNotificationAction {
        UNNotificationAction(identifier: "answer.\(value)", title: title, options: [.authenticationRequired])
    }

    static var fixed: Set<UNNotificationCategory> {
        var out: Set<UNNotificationCategory> = [UNNotificationCategory(identifier: "artipeek.reply", actions: [reply, open], intentIdentifiers: [])]
        for set in fixedValueSets {
            let actions = set.map { answer(String($0), title: String($0)) } + [reply, open]
            out.insert(UNNotificationCategory(identifier: "artipeek.opts.\(set)", actions: actions, intentIdentifiers: []))
        }
        return out
    }
}
