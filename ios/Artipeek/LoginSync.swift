import WebKit

// The login of the web view (Cloudflare Access cookie CF_Authorization of the server), copied to the Keychain so a
// button on a push can answer while the app is in the background, and sent to the Watch app. Refreshed each time
// artipeek's own page has loaded.
@MainActor
enum LoginSync {
    static func refresh(server: URL, store: WKHTTPCookieStore) async {
        let cookies = await store.allCookies()
        let host = server.host?.lowercased() ?? ""
        let c = cookies.filter { $0.name == "CF_Authorization" && (host == $0.domain.lowercased() || host.hasSuffix("." + $0.domain.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))) || $0.domain.lowercased() == "." + host) }
            .max { ($0.expiresDate ?? .distantPast) < ($1.expiresDate ?? .distantPast) }
        guard let c else { return } // no Access in front (e.g. a tailnet address): nothing to share
        let login = Login(server: server, cookie: c.value, expires: c.expiresDate)
        if Vault.login != login { Vault.login = login }
        WatchLink.shared.send(login)
    }

    static func clear() {
        Vault.login = nil
        WatchLink.shared.send(nil)
    }

    // The saved login; else one read from the web view's cookies now.
    static func current() async -> Login? {
        if let l = Vault.login, !l.isExpired { return l }
        let server = AppModel.shared.server
        guard let server else { return nil }
        await refresh(server: server, store: WKWebsiteDataStore.default().httpCookieStore)
        return Vault.login
    }
}
