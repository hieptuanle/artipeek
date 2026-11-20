import SwiftUI

// artipeek on the Watch: open decisions, urgent first; tap one, tap an answer, confirm. The login comes from the
// iPhone app (after you log in there); answers go to the server directly (Wi-Fi or cellular), as yours.
@main
struct ArtipeekWatchApp: App {
    @StateObject private var store = WatchStore()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            NavigationStack(path: $store.path) { DecisionListView() }
                .environmentObject(store)
                .onAppear { store.start() }
                .onChange(of: phase) { _, p in if p == .active { Task { await store.reload() } } }
        }
    }
}
