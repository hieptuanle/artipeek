import SwiftUI

struct DecisionListView: View {
    @EnvironmentObject private var store: WatchStore

    var body: some View {
        List {
            if let s = store.snapshot {
                Section {
                    if s.decisions.isEmpty { Text("No open decisions.").foregroundStyle(.secondary) }
                    ForEach(s.decisions, id: \.key) { d in
                        NavigationLink(value: d) { DecisionRow(d: d) }
                    }
                } header: {
                    Text("\(s.open) open\(s.urgent > 0 ? " · \(s.urgent) urgent" : "")")
                }
                // a server from before actions sends none: no sections
                if s.actions != nil {
                    Section {
                        if s.todo.isEmpty { Text("Nothing for you to do.").foregroundStyle(.secondary) }
                        ForEach(s.todo, id: \.key) { a in
                            NavigationLink(value: a) { ActionRow(a: a) }
                        }
                    } header: {
                        Text("\(s.actionsTodo) action\(s.actionsTodo == 1 ? "" : "s") to do\((s.actionCounts?.urgent ?? 0) > 0 ? " · \(s.actionCounts!.urgent) urgent" : "")")
                    }
                    if !s.withAgent.isEmpty {
                        Section("With the agent") {
                            ForEach(s.withAgent, id: \.key) { a in
                                NavigationLink(value: a) { ActionRow(a: a) }
                            }
                        }
                    }
                }
            }
            if let e = store.error {
                Text(e).font(.footnote).foregroundStyle(store.login == nil ? Color.secondary : Color.red)
            }
        }
        .navigationTitle("artipeek")
        .navigationDestination(for: Decision.self) { DecisionView(d: $0) }
        .navigationDestination(for: ActionItem.self) { ActionView(a0: $0) }
        .refreshable { await store.reload() }
        .task { await store.reload() }
        .overlay { if store.loading && store.snapshot == nil { ProgressView() } }
    }
}

struct DecisionRow: View {
    let d: Decision
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                if d.urgent { Circle().fill(.red).frame(width: 7, height: 7) }
                Text("\(d.project) · \(d.id)").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }
            Text(d.title).font(.footnote.weight(.medium)).lineLimit(3)
            if let due = d.deadlineDate {
                Text(due, style: .relative).font(.caption2).foregroundStyle(d.urgent ? .red : .secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

struct ActionRow: View {
    let a: ActionItem
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                if a.urgent { Circle().fill(.red).frame(width: 7, height: 7) }
                Text("\(a.project) · \(a.id)").font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                Spacer(minLength: 2)
                Text(a.progress).font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
            }
            Text(a.title).font(.footnote.weight(.medium)).lineLimit(3)
            if !a.isTodo {
                Text(ActionView.statusText(a.status)).font(.caption2).foregroundStyle(.secondary)
            } else if let due = a.deadlineDate {
                Text(due, style: .relative).font(.caption2).foregroundStyle(a.urgent ? .red : .secondary)
            }
        }
        .padding(.vertical, 2)
    }
}
