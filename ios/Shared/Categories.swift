import UserNotifications

// Buttons on artipeek's pushes. The server picks a category: a fixed one for the usual option values (letter buttons,
// shown on the Watch too), or "artipeek.reply". The notification extension may add a category with the options' labels.
// Button ids: "answer.<value>", "reply" (typed, dictated or scribbled answer), "open".
// An action's push (category "artipeek.action", app 1.2): "agent" (Ask the agent…, an optional note, then Send: posts
// op "agent" like the Actions tab) and "open". Typing Send is the confirmation the page's sheet asks for.
enum PushCategories {
    static let fixedValueSets = ["AB", "ABC", "ABCD", "YN"] // must match push/notify.ts
    static let reply = UNTextInputNotificationAction(identifier: "reply", title: "Reply…", options: [.authenticationRequired],
                                                     textInputButtonTitle: "Send", textInputPlaceholder: "A, or your own answer")
    static let open = UNNotificationAction(identifier: "open", title: "Open", options: [.foreground])

    static func answer(_ value: String, title: String) -> UNNotificationAction {
        UNNotificationAction(identifier: "answer.\(value)", title: title, options: [.authenticationRequired])
    }

    static let action = "artipeek.action"
    static let askAgent = UNTextInputNotificationAction(identifier: "agent", title: "Ask the agent to do it…", options: [.authenticationRequired],
                                                        textInputButtonTitle: "Send", textInputPlaceholder: "Note for the agent (optional)")

    static var fixed: Set<UNNotificationCategory> {
        var out: Set<UNNotificationCategory> = [
            UNNotificationCategory(identifier: "artipeek.reply", actions: [reply, open], intentIdentifiers: []),
            UNNotificationCategory(identifier: action, actions: [askAgent, open], intentIdentifiers: []),
        ]
        for set in fixedValueSets {
            let actions = set.map { answer(String($0), title: String($0)) } + [reply, open]
            out.insert(UNNotificationCategory(identifier: "artipeek.opts.\(set)", actions: actions, intentIdentifiers: []))
        }
        return out
    }
}
