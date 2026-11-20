import SwiftUI
import WidgetKit

// Complication: open and urgent decisions (from the server every 15 minutes, and whenever the Watch app refreshes).
@main
struct ArtipeekWidgets: WidgetBundle {
    var body: some Widget { DecisionsWidget() }
}

struct DecisionsEntry: TimelineEntry {
    var date: Date
    var open: Int
    var urgent: Int
    var top: String?
    var known: Bool
}

struct DecisionsProvider: TimelineProvider {
    func placeholder(in context: Context) -> DecisionsEntry { DecisionsEntry(date: Date(), open: 3, urgent: 1, top: "Ship the beta on Friday?", known: true) }

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
        let top = s.decisions.first(where: \.urgent) ?? s.decisions.first
        return DecisionsEntry(date: Date(), open: s.open, urgent: s.urgent, top: top.map { "\($0.id) \($0.title)" }, known: true)
    }
}

struct DecisionsWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "artipeek.decisions", provider: DecisionsProvider()) { e in
            DecisionsWidgetView(e: e).containerBackground(for: .widget) { Color.clear }
        }
        .configurationDisplayName("Decisions")
        .description("Open and urgent decisions in artipeek.")
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
                    Text(e.urgent > 0 ? "\(e.urgent) urgent" : "open").font(.system(size: 9)).foregroundStyle(e.urgent > 0 ? .red : .secondary)
                }
            }
        case .accessoryRectangular:
            VStack(alignment: .leading, spacing: 1) {
                Text("artipeek").font(.caption2.bold()).widgetAccentable()
                Text(e.known ? "\(e.open) open\(e.urgent > 0 ? " · \(e.urgent) urgent" : "")" : "Open the app").font(.caption)
                if let t = e.top { Text(t).font(.caption2).foregroundStyle(.secondary).lineLimit(1) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        case .accessoryCorner:
            Text(e.known ? "\(e.open)" : "–").font(.title3.bold())
                .widgetLabel(e.urgent > 0 ? "\(e.urgent) urgent" : "open")
        default:
            Text(e.known ? "\(e.open) open\(e.urgent > 0 ? " · \(e.urgent) urgent" : "")" : "artipeek")
        }
    }
}
