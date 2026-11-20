import SafariServices
import UIKit
import UserNotifications
import WebKit

// The web view that shows artipeek, and what Safari would do for it: the Cloudflare Access login in the same view,
// outside links in a Safari sheet, same-site new windows in a sheet, downloads to the share sheet, pull to refresh.
// The login lives in the persistent website data store (cookie CF_Authorization), so it survives restarts.
@MainActor
final class WebController: NSObject, ObservableObject {
    let webView: WKWebView
    @Published private(set) var loadError: String?
    @Published private(set) var onArtipeekPage = false // artipeek's own page (not the login, not an error)
    @Published private(set) var started = false

    private unowned let model: AppModel
    private let refresh = UIRefreshControl()
    private var pendingOpen: URL?
    private var downloads: [ObjectIdentifier: URL] = [:]

    init(model: AppModel) {
        self.model = model
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()
        cfg.allowsInlineMediaPlayback = true
        cfg.applicationNameForUserAgent = "Mobile/15E148 Safari/604.1 artipeek-ios/1"
        cfg.userContentController.addUserScript(WKUserScript(source: Self.settingsButtonJS, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: .defaultClient))
        webView = WKWebView(frame: .zero, configuration: cfg)
        super.init()
        cfg.userContentController.add(WeakHandler(self), contentWorld: .defaultClient, name: "artipeekApp")
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.isOpaque = false
        webView.backgroundColor = .artipeekBackground
        webView.underPageBackgroundColor = .artipeekBackground
        webView.scrollView.refreshControl = refresh
        refresh.addTarget(self, action: #selector(pulled), for: .valueChanged)
        #if DEBUG
        webView.isInspectable = true
        #endif
    }

    // ----- loading -----

    func start() {
        guard !started else { return }
        started = true
        if let url = pendingOpen { pendingOpen = nil; load(url) } else { loadStart() }
    }

    func loadStart() {
        guard let server = model.server else { return }
        load(server.appendingPathComponent("decisions"))
    }

    func reload() {
        loadError = nil
        if webView.url == nil { loadStart() } else { webView.reload() }
    }

    private func load(_ url: URL) {
        loadError = nil
        webView.load(URLRequest(url: url))
    }

    // Open a page of the app (a decision from a push). Inside artipeek's page this is an in-app navigation (the app's
    // own popstate handling opens the Decisions tab and scrolls to the decision); otherwise a full load.
    func open(_ url: URL) {
        guard started else { pendingOpen = url; return }
        guard onArtipeekPage, isServer(url), isServer(webView.url) else { load(url); return }
        Task {
            let js = """
            if (!document.body || !document.body.classList.contains("app")) return false;
            history.pushState(null, "", u);
            dispatchEvent(new PopStateEvent("popstate"));
            return true;
            """
            let done = (try? await webView.callAsyncJavaScript(js, arguments: ["u": url.absoluteString], contentWorld: .page)) as? Bool
            if done != true { load(url) }
        }
    }

    @objc private func pulled() { reload() }

    func clearData() async {
        let store = webView.configuration.websiteDataStore
        await store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
        onArtipeekPage = false
    }

    // ----- calls from the app to the server, as artipeek's own page (same login, same-origin fetch) -----

    struct Reply { var status: Int; var body: [String: Any]; var error: String }

    func postJSON(_ path: String, _ body: [String: String]) async -> Reply {
        guard onArtipeekPage else { return Reply(status: 0, body: [:], error: "not logged in") }
        let js = """
        const r = await fetch(path, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-Artipeek": "push" }, body: JSON.stringify(body) });
        let j = {};
        try { j = await r.json(); } catch (e) {}
        return { status: r.status, body: j };
        """
        do {
            let res = try await webView.callAsyncJavaScript(js, arguments: ["path": path, "body": body], contentWorld: .page)
            let d = res as? [String: Any] ?? [:]
            let status = (d["status"] as? NSNumber)?.intValue ?? 0
            let b = d["body"] as? [String: Any] ?? [:]
            return Reply(status: status, body: b, error: b["error"] as? String ?? "HTTP \(status)")
        } catch {
            return Reply(status: 0, body: [:], error: error.localizedDescription)
        }
    }

    // Badge = open decisions this login can see (the same number a push sets).
    func refreshBadge() async {
        guard onArtipeekPage else { return }
        let js = """
        const r = await fetch("/decisions/part/counts", { credentials: "same-origin" });
        if (!r.ok) return -1;
        const j = await r.json();
        let n = 0;
        for (const k in j.counts || {}) n += j.counts[k].open || 0;
        return n;
        """
        if let n = (try? await webView.callAsyncJavaScript(js, contentWorld: .page)) as? Int, n >= 0 {
            try? await UNUserNotificationCenter.current().setBadgeCount(n)
        }
    }

    // ----- helpers -----

    func isServer(_ url: URL?) -> Bool {
        guard let host = url?.host?.lowercased(), let s = model.server?.host?.lowercased() else { return false }
        return host == s
    }

    private func isAccess(_ url: URL?) -> Bool {
        guard let host = url?.host?.lowercased() else { return false }
        return host.hasSuffix(".cloudflareaccess.com")
    }

    fileprivate func message(_ body: Any) {
        if (body as? String) == "settings" { model.showSettings = true }
    }

    private func pageDone(_ wv: WKWebView) {
        refresh.endRefreshing()
        guard wv === webView else { return }
        Task {
            var isApp = isServer(wv.url) && !(wv.url?.path.hasPrefix("/cdn-cgi/") ?? false)
            if isApp {
                let r = try? await wv.evaluateJavaScript("!!document.body && /\\b(app|home)\\b/.test(document.body.className)")
                isApp = (r as? Bool) ?? false
            }
            onArtipeekPage = isApp
            #if DEBUG
            let gear = (try? await wv.evaluateJavaScript("!!document.getElementById('artipeek-app-settings')")) as? Bool
            print("artipeek-debug: page \(wv.url?.absoluteString ?? "-") artipeek=\(isApp) gear=\(gear ?? false)")
            #endif
            if isApp {
                model.pageReady()
                if let server = model.server { await LoginSync.refresh(server: server, store: wv.configuration.websiteDataStore.httpCookieStore) }
            } else if isAccess(wv.url) { model.loginShown() }
        }
    }

    private func failed(_ wv: WKWebView, _ error: Error) {
        refresh.endRefreshing()
        let e = error as NSError
        // cancelled (a new load started), or "frame load interrupted" (it became a download)
        if e.code == NSURLErrorCancelled || (e.domain == "WebKitErrorDomain" && e.code == 102) { return }
        guard wv === webView else { return }
        onArtipeekPage = false
        loadError = e.localizedDescription
    }

    static func topController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first { $0.activationState == .foregroundActive }
            ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        var top = scene?.windows.first { $0.isKeyWindow }?.rootViewController ?? scene?.windows.first?.rootViewController
        while let p = top?.presentedViewController { top = p }
        return top
    }

    private func openOutside(_ url: URL) {
        if url.scheme == "http" || url.scheme == "https" {
            let vc = SFSafariViewController(url: url)
            vc.dismissButtonStyle = .close
            Self.topController()?.present(vc, animated: true)
        } else {
            UIApplication.shared.open(url)
        }
    }

    // A gear button in artipeek's own header (the file list header, or the home page title) opens the app settings.
    // Runs in the app's own script world: the page can't see or call it, and the page's CSP doesn't apply.
    static let settingsButtonJS = """
    (function () {
      function add() {
        if (document.getElementById("artipeek-app-settings")) return;
        var host = document.querySelector("aside header .headrow") || document.querySelector(".home h1");
        if (!host) return;
        var b = document.createElement("button");
        b.id = "artipeek-app-settings"; b.type = "button"; b.setAttribute("aria-label", "App settings"); b.textContent = "\\u2699\\uFE0E";
        b.style.cssText = "flex:none;font:inherit;font-size:15px;line-height:1;padding:4px 8px;margin-left:6px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--muted);cursor:pointer;vertical-align:middle;";
        if (host.tagName === "H1") b.style.float = "right";
        b.addEventListener("click", function (e) { e.preventDefault(); window.webkit.messageHandlers.artipeekApp.postMessage("settings"); });
        host.appendChild(b);
      }
      add();
      new MutationObserver(add).observe(document.documentElement, { childList: true, subtree: true });
    })();
    """
}

// ----- navigation -----

extension WebController: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        if action.shouldPerformDownload { return .download }
        guard let url = action.request.url else { return .cancel }
        let scheme = url.scheme?.lowercased() ?? ""
        if scheme == "about" || scheme == "blob" || scheme == "data" { return .allow }
        if scheme != "http" && scheme != "https" { openOutside(url); return .cancel } // mailto:, tel:
        // Frames (artipeek's sandboxed HTML pages) load as they would in Safari.
        guard action.targetFrame?.isMainFrame ?? true else { return .allow }
        // artipeek and its Access login stay here; a tapped link elsewhere opens in a Safari sheet.
        if isServer(url) || isAccess(url) { return .allow }
        if action.navigationType == .linkActivated { openOutside(url); return .cancel }
        return .allow // redirects (an identity provider during login)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse) async -> WKNavigationResponsePolicy {
        if let http = response.response as? HTTPURLResponse,
           let cd = http.value(forHTTPHeaderField: "Content-Disposition"), cd.lowercased().hasPrefix("attachment") {
            return .download
        }
        return response.canShowMIMEType ? .allow : .download
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { pageDone(webView) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { failed(webView, error) }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { failed(webView, error) }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { webView.reload() }
}

// ----- new windows (target=_blank, window.open) -----

extension WebController: WKUIDelegate {
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = action.request.url else { return nil }
        if !isServer(url) { openOutside(url); return nil }
        // A file of artipeek (e.g. "raw"): a sheet with its own web view, same login.
        let child = WKWebView(frame: .zero, configuration: configuration)
        child.navigationDelegate = self
        child.uiDelegate = self
        child.backgroundColor = .artipeekBackground
        let vc = PopupController(webView: child)
        Self.topController()?.present(UINavigationController(rootViewController: vc), animated: true)
        return child
    }

    func webViewDidClose(_ webView: WKWebView) {
        if webView !== self.webView { Self.topController()?.dismiss(animated: true) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
            let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            a.addAction(UIAlertAction(title: "OK", style: .default) { _ in c.resume() })
            if let top = Self.topController() { top.present(a, animated: true) } else { c.resume() }
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async -> Bool {
        await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
            let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            a.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in c.resume(returning: false) })
            a.addAction(UIAlertAction(title: "OK", style: .default) { _ in c.resume(returning: true) })
            if let top = Self.topController() { top.present(a, animated: true) } else { c.resume(returning: false) }
        }
    }
}

// ----- downloads: saved to a temporary folder, then the share sheet (Save to Files, AirDrop…) -----

extension WebController: WKDownloadDelegate {
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String) async -> URL? {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("downloads/\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let name = suggestedFilename.isEmpty ? "download" : suggestedFilename.replacingOccurrences(of: "/", with: "_")
        let dest = dir.appendingPathComponent(name)
        downloads[ObjectIdentifier(download)] = dest
        return dest
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let file = downloads.removeValue(forKey: ObjectIdentifier(download)), let top = Self.topController() else { return }
        let share = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        share.popoverPresentationController?.sourceView = top.view
        share.popoverPresentationController?.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.midY, width: 1, height: 1)
        top.present(share, animated: true)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.removeValue(forKey: ObjectIdentifier(download))
        let a = UIAlertController(title: "Download failed", message: error.localizedDescription, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default))
        Self.topController()?.present(a, animated: true)
    }
}

// The page's messages to the app (only the settings button). Weak, so the controller isn't kept alive by WebKit.
private final class WeakHandler: NSObject, WKScriptMessageHandler {
    weak var target: WebController?
    init(_ t: WebController) { target = t }
    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        let body = message.body
        MainActor.assumeIsolated { target?.message(body) }
    }
}

// A same-site new window, shown as a sheet.
private final class PopupController: UIViewController {
    let webView: WKWebView
    private var titleObs: NSKeyValueObservation?
    init(webView: WKWebView) { self.webView = webView; super.init(nibName: nil, bundle: nil) }
    required init?(coder: NSCoder) { fatalError() }
    override func loadView() { view = webView }
    override func viewDidLoad() {
        super.viewDidLoad()
        navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .done, primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })
        titleObs = webView.observe(\.title, options: [.initial, .new]) { [weak self] wv, _ in
            let t = wv.title
            Task { @MainActor in self?.title = t }
        }
    }
}

extension UIColor {
    // artipeek's page background: white, or GitHub-dark in dark mode
    static let artipeekBackground = UIColor { t in
        t.userInterfaceStyle == .dark ? UIColor(red: 0x0d / 255, green: 0x11 / 255, blue: 0x17 / 255, alpha: 1) : .white
    }
}
