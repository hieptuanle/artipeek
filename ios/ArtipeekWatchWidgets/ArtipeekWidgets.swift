import SwiftUI
import WidgetKit

// Complication: what waits for you, open decisions + actions to do (the app's badge rule), and how many are urgent
// (from the server every 15 minutes, and whenever the Watch app refreshes). A server without actions: decisions only.
@main
struct ArtipeekWidgets: WidgetBundle {
    var body: some Widget { DecisionsWidget() }
}

struct DecisionsEntry: TimelineEntry {
    var date: Date
    var open: Int // open decisions + actions to do
    var urgent: Int
    var top: String?
    var known: Bool
    var decisions = 0
    var actions = 0
    // "2 decisions · 1 action", or "3 open" before actions
    var parts: String {
        guard actions > 0 else { return "\(open) open" }
        return (decisions > 0 ? "\(decisions) decision\(decisions == 1 ? "" : "s") · " : "") + "\(actions) action\(actions == 1 ? "" : "s")"
    }
}

struct DecisionsProvider: TimelineProvider {
    func placeholder(in context: Context) -> DecisionsEntry { DecisionsEntry(date: Date(), open: 3, urgent: 1, top: "Ship the beta on Friday?", known: true, decisions: 2, actions: 1) }

    func getSnapshot(in context: Context, completion: @escaping (DecisionsEntry) -> Void) {
        completion(Self.entry(Vault.snapshot) ?? placeholder(in: context))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<DecisionsEntry>) -> Void) {
        Task {
            var snap = Vault.snapshot
            if let login = Vault.login, let s = try? await ArtipeekAPI(login).list() { snap = s; Vault.snapshot = s }
            let e = Self.entry(snap) ?? DecisionsEntry(date: Date(), open: 0, urgent: 0, top: nil, known: false)
            completion(Timeline(entries: [e], policy: .after(Date().addingTimeInterval(15 * 60))))
        }
    }

    static func entry(_ s: Snapshot?) -> DecisionsEntry? {
        guard let s else { return nil }
        let urgentAction = s.todo.first(where: \.urgent).map { "\($0.id) \($0.title)" }
        let urgentDecision = s.decisions.first(where: \.urgent).map { "\($0.id) \($0.title)" }
        let top = urgentDecision ?? urgentAction ?? s.decisions.first.map { "\($0.id) \($0.title)" } ?? s.todo.first.map { "\($0.id) \($0.title)" }
        return DecisionsEntry(date: Date(), open: s.forYou, urgent: s.urgentAll, top: top, known: true, decisions: s.open, actions: s.actionsTodo)
    }
}

struct DecisionsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "artipeek.decisions", provider: DecisionsProvider()) { e in
            DecisionsWidgetView(e: e).containerBackground(for: .widget) { Color.clear }
        }
        .configurationDisplayName("Decisions")
        .description("Open decisions and actions to do in artipeek, and how many are urgent.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline, .accessoryCorner])
    }
}

struct DecisionsWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let e: DecisionsEntry

    var body: some View {
        switch family {
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                VStack(spacing: 0) {
                    Text(e.known ? "\(e.open)" : "–").font(.title3.bold())
                    Text(e.urgent > 0 ? "\(e.urgent) urgent" : e.actions > 0 ? "for you" : "open").font(.system(size: 9)).foregroundStyle(e.urgent > 0 ? .red : .secondary)
                }
            }
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 1) {
                Text("artipeek").font(.caption2.bold()).widgetAccentable()
                Text(e.known ? "\(e.parts)\(e.urgent > 0 ? " · \(e.urgent) urgent" : "")" : "Open the app").font(.caption)
                if let t = e.top { Text(t).font(.caption2).foregroundStyle(.secondary).lineLimit(1) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        case .accessoryCorner:
            Text(e.known ? "\(e.open)" : "–").font(.title3.bold())
                .widgetLabel(e.urgent > 0 ? "\(e.urgent) urgent" : e.actions > 0 ? "for you" : "open")
        default:
            Text(e.known ? "\(e.parts)\(e.urgent > 0 ? " · \(e.urgent) urgent" : "")" : "artipeek")
        }
    }
}
