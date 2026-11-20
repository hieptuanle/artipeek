import SwiftUI

// artipeek for iOS: artipeek's own web UI in a native shell, plus push notifications for decisions.
@main
struct ArtipeekApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var model = AppModel.shared
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            ContentView(web: model.web)
                .environmentObject(model)
                .onChange(of: phase) { _, p in
                    if p == .active { model.becameActive() }
                }
        }
    }
}
