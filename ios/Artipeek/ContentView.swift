import SwiftUI
import WebKit

struct ContentView: View {
    @EnvironmentObject private var model: AppModel
    @ObservedObject var web: WebController

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color(uiColor: .artipeekBackground).ignoresSafeArea()
            WebViewHost(webView: web.webView)
                .ignoresSafeArea(.keyboard)
            if let err = web.loadError {
                LoadErrorView(message: err, server: model.server) { web.reload() } settings: { model.showSettings = true }
            } else if !web.onArtipeekPage && web.started {
                // the login page (or anything not artipeek's own page): the gear in artipeek's header isn't there
                Button { model.showSettings = true } label: {
                    Image(systemName: "gearshape").font(.system(size: 15, weight: .semibold)).padding(9)
                }
                .buttonStyle(.plain)
                .background(.ultraThinMaterial, in: Circle())
                .padding(.trailing, 10)
                .padding(.top, 4)
                .accessibilityLabel("App settings")
            }
        }
        .sheet(isPresented: $model.showSettings) {
            SettingsView().environmentObject(model)
        }
        .onAppear { web.start() }
    }
}

// The web view, kept inside the safe areas (artipeek's page doesn't pad for the notch or the home bar).
struct WebViewHost: UIViewRepresentable {
    let webView: WKWebView
    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

struct LoadErrorView: View {
    let message: String
    let server: URL?
    let retry: () -> Void
    let settings: () -> Void

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "wifi.exclamationmark").font(.system(size: 40)).foregroundStyle(.secondary)
            Text("Can't open artipeek").font(.headline)
            Text(message).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
            if let host = server?.host { Text(host).font(.footnote.monospaced()).foregroundStyle(.secondary) }
            HStack(spacing: 12) {
                Button("Try again", action: retry).buttonStyle(.borderedProminent)
                Button("Settings", action: settings).buttonStyle(.bordered)
            }
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(uiColor: .artipeekBackground))
    }
}
