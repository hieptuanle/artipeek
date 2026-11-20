import Foundation
import Security

// What the iPhone app, its notification buttons, the Watch app and the complication share: the login (the Cloudflare
// Access cookie of the artipeek server, taken from the iPhone's web view after you log in there) and a small client for
// the two calls a native screen needs: the list of open decisions, and sending an answer. Both go through the same
// login and the same rules as artipeek's page.

struct Login: Codable, Equatable {
    var server: URL
    var cookie: String // value of CF_Authorization
    var expires: Date?
    var isExpired: Bool { expires.map { $0 < Date() } ?? false }
}

struct Option: Codable, Hashable { var value: String; var label: String; var recommended: Bool }
struct Question: Codable, Hashable { var key: String; var text: String; var options: [Option] }
struct LastAnswer: Codable, Hashable { var text: String; var at: String }

struct Decision: Codable, Hashable {
    var project: String
    var id: String
    var title: String
    var lane: String?
    var urgent: Bool
    var flagged: Bool
    var deadline: String?
    var context: String
    var ifNoAnswer: String?
    var questions: [Question]
    var lastAnswer: LastAnswer?
    var url: String
    var key: String { "\(project)/\(id)" }
    var deadlineDate: Date? { deadline.flatMap { ISO8601DateFormatter.withFraction.date(from: $0) ?? ISO8601DateFormatter().date(from: $0) } }
}

struct Snapshot: Codable {
    var open: Int
    var urgent: Int
    var decisions: [Decision]
    var fetchedAt: Date?
}

enum APIError: LocalizedError {
    case noLogin, loginExpired, refused(String), network(String)
    var errorDescription: String? {
        switch self {
        case .noLogin: return "Open artipeek on your iPhone and log in."
        case .loginExpired: return "The login ran out. Open artipeek on your iPhone and log in again."
        case .refused(let m): return m
        case .network(let m): return m
        }
    }
}

final class ArtipeekAPI: NSObject, URLSessionTaskDelegate {
    let login: Login
    private lazy var session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 20
        c.httpCookieAcceptPolicy = .never
        c.httpShouldSetCookies = false
        return URLSession(configuration: c, delegate: self, delegateQueue: nil)
    }()

    init(_ login: Login) { self.login = login }

    // A redirect means Cloudflare Access wants a new login: don't follow it to the login page.
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest) async -> URLRequest? { nil }

    private func request(_ path: String) -> URLRequest {
        var r = URLRequest(url: URL(string: login.server.absoluteString + path)!)
        r.setValue("CF_Authorization=\(login.cookie)", forHTTPHeaderField: "Cookie")
        return r
    }

    private func send(_ r: URLRequest) async throws -> (Data, HTTPURLResponse) {
        if login.isExpired { throw APIError.loginExpired }
        do {
            let (data, resp) = try await session.data(for: r)
            guard let http = resp as? HTTPURLResponse else { throw APIError.network("no answer") }
            if (300..<400).contains(http.statusCode) || http.statusCode == 401 { throw APIError.loginExpired }
            return (data, http)
        } catch let e as APIError { throw e } catch { throw APIError.network(error.localizedDescription) }
    }

    func list() async throws -> Snapshot {
        let (data, http) = try await send(request("/decisions/part/app.json"))
        guard http.statusCode == 200, (http.value(forHTTPHeaderField: "Content-Type") ?? "").contains("json") else {
            throw http.statusCode == 403 ? APIError.loginExpired : APIError.refused("HTTP \(http.statusCode)")
        }
        var s = try JSONDecoder().decode(Snapshot.self, from: data)
        s.fetchedAt = Date()
        return s
    }

    // The same call as the answer sheet of artipeek's page (same headers; the login cookie instead of the browser's).
    // page: "artipeek:push" (a button on a push) or "artipeek:watch".
    func answer(project: String, id: String, text: String, page: String) async throws {
        var r = request("/r/\(project.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? project)/answer")
        r.httpMethod = "POST"
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        r.setValue("answer", forHTTPHeaderField: "X-Artipeek")
        r.setValue("same-origin", forHTTPHeaderField: "Sec-Fetch-Site")
        r.httpBody = try JSONSerialization.data(withJSONObject: ["id": id, "text": text, "page": page])
        let (data, http) = try await send(r)
        if http.statusCode == 200 { return }
        let msg = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
        if http.statusCode == 403 && msg == nil { throw APIError.loginExpired }
        throw APIError.refused(msg ?? "HTTP \(http.statusCode)")
    }
}

extension ISO8601DateFormatter {
    static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}

// The login and the last list, in the Keychain. On the Watch, the app and its complication share them through a
// keychain group (Info.plist "ArtipeekKeychainGroup"); the iPhone app keeps its own.
enum Vault {
    private static let service = "artipeek"
    private static var group: String? {
        let g = Bundle.main.object(forInfoDictionaryKey: "ArtipeekKeychainGroup") as? String
        return (g?.isEmpty ?? true) || g!.contains("$(") ? nil : g
    }

    private static func query(_ account: String) -> [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
        if let group { q[kSecAttrAccessGroup as String] = group }
        return q
    }

    static func put<T: Encodable>(_ value: T?, _ account: String) {
        SecItemDelete(query(account) as CFDictionary)
        guard let value, let data = try? JSONEncoder().encode(value) else { return }
        var q = query(account)
        q[kSecValueData as String] = data
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock // the buttons on a push work while locked in a pocket
        SecItemAdd(q as CFDictionary, nil)
    }

    static func get<T: Decodable>(_ type: T.Type, _ account: String) -> T? {
        var q = query(account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    static var login: Login? {
        get { get(Login.self, "login") }
        set { put(newValue, "login") }
    }
    static var snapshot: Snapshot? {
        get { get(Snapshot.self, "snapshot") }
        set { put(newValue, "snapshot") }
    }
}
