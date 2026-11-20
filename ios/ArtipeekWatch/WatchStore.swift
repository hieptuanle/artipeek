import SwiftUI
import WatchConnectivity
import WidgetKit

@MainActor
final class WatchStore: NSObject, ObservableObject {
    @Published private(set) var snapshot: Snapshot? = Vault.snapshot
    @Published private(set) var login: Login? = Vault.login
    @Published var error: String?
    @Published private(set) var loading = false
    @Published var path: [Decision] = []

    func start() {
        #if DEBUG
        // Development only: `-serverURL http://127.0.0.1:4341` (a local server whose proxy adds the login) instead of the
        // iPhone's login.
        if let u = UserDefaults.standard.string(forKey: "serverURL"), let url = URL(string: u) { login = Login(server: url, cookie: "debug", expires: nil) }
        #endif
        guard WCSession.isSupported(), WCSession.default.delegate == nil else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    func reload() async {
        guard let login else { askPhone(); error = APIError.noLogin.errorDescription; return }
        loading = true
        defer { loading = false }
        do {
            let s = try await ArtipeekAPI(login).list()
            snapshot = s
            Vault.snapshot = s
            error = nil
            #if DEBUG
            if let k = UserDefaults.standard.string(forKey: "openDecision"), path.isEmpty, let d = s.decisions.first(where: { $0.key == k }) { path = [d] }
            #endif
            WidgetCenter.shared.reloadAllTimelines()
        } catch {
            self.error = error.localizedDescription
            if case APIError.loginExpired = error { askPhone() }
        }
    }

    func answer(_ d: Decision, text: String) async throws {
        guard let login else { throw APIError.noLogin }
        try await ArtipeekAPI(login).answer(project: d.project, id: d.id, text: text, page: "artipeek:watch")
        Task { await reload() }
    }

    fileprivate func apply(_ ctx: [String: Any]) {
        if ctx["signedOut"] as? Bool == true {
            login = nil; snapshot = nil; Vault.login = nil; Vault.snapshot = nil
            WidgetCenter.shared.reloadAllTimelines()
            return
        }
        guard let data = ctx["login"] as? Data, let l = try? JSONDecoder().decode(Login.self, from: data) else { return }
        if l != login {
            login = l
            Vault.login = l
            Task { await reload() }
        }
    }

    // Ask the iPhone for its login (when it is reachable).
    private func askPhone() {
        guard WCSession.isSupported(), WCSession.default.activationState == .activated, WCSession.default.isReachable else { return }
        WCSession.default.sendMessage(["want": "login"], replyHandler: { reply in
            Task { @MainActor in self.apply(reply) }
        }, errorHandler: nil)
    }
}

extension WatchStore: WCSessionDelegate {
    nonisolated func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {
        let ctx = session.receivedApplicationContext
        Task { @MainActor in
            if !ctx.isEmpty { self.apply(ctx) }
            if self.login == nil { self.askPhone() }
        }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext ctx: [String: Any]) {
        Task { @MainActor in self.apply(ctx) }
    }
}
