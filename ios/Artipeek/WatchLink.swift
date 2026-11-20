import WatchConnectivity

// Sends the login to the Watch app (WatchConnectivity application context: the latest one wins, delivered when the
// Watch can take it). nil = signed out.
final class WatchLink: NSObject, WCSessionDelegate {
    static let shared = WatchLink()
    private var pending: [String: Any]?

    func start() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    func send(_ login: Login?) {
        let ctx: [String: Any] = login.flatMap { try? JSONEncoder().encode($0) }.map { ["login": $0] } ?? ["signedOut": true]
        guard WCSession.isSupported() else { return }
        let s = WCSession.default
        guard s.activationState == .activated else { pending = ctx; return }
        guard s.isPaired, s.isWatchAppInstalled else { return }
        try? s.updateApplicationContext(ctx)
    }

    func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {
        if state == .activated, let p = pending, session.isPaired, session.isWatchAppInstalled { pending = nil; try? session.updateApplicationContext(p) }
        else if state == .activated, pending == nil, let l = Vault.login { send(l) }
    }

    // The Watch asks for the login (first launch, or after it ran out).
    func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
        if message["want"] as? String == "login", let l = Vault.login, let data = try? JSONEncoder().encode(l) {
            replyHandler(["login": data])
        } else {
            replyHandler([:])
        }
    }

    func sessionDidBecomeInactive(_ session: WCSession) {}
    func sessionDidDeactivate(_ session: WCSession) { session.activate() }
}
