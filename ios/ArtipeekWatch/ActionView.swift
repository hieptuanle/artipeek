import SwiftUI

// One action: its steps with their states. Tap a step to tick it (or untick it), "All done", or "Ask the agent to do
// it", each confirmed before it is sent, as answers are. Commands are shown in full, to read, not to copy.
struct ActionView: View {
    @EnvironmentObject private var store: WatchStore
    @Environment(\.dismiss) private var dismiss
    let a0: ActionItem
    @State private var pending: ActionOp?
    @State private var note = ""
    @State private var result: String?
    @State private var sending = false

    private var a: ActionItem { store.latest(a0) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text("\(a.project) · \(a.id)\(a.urgent ? " · urgent" : "")").font(.caption2).foregroundStyle(a.urgent ? .red : .secondary)
                Text(a.title).font(.headline)
                Text("\(a.progress) steps ticked · \(Self.statusText(a.status))").font(.caption2).foregroundStyle(.secondary)
                if let due = a.deadlineDate {
                    (Text("Deadline ") + Text(due, style: .relative)).font(.caption2).foregroundStyle(a.urgent ? .red : .secondary)
                }
                if !a.from.isEmpty { Text("From \(a.from.joined(separator: ", "))").font(.caption2).foregroundStyle(.secondary) }
                if a.status == "agent" {
                    Text("You asked the agent to do it\(a.agentNote.map { ": \($0)" } ?? ".")").font(.caption2).foregroundStyle(.orange)
                }
                if let r = a.resolution, !r.isEmpty { Text("Agent: \(r)").font(.caption2).foregroundStyle(.secondary) }

                ForEach(a.steps, id: \.n) { x in
                    Button { tap(x) } label: { StepLabel(x: x) }
                        .disabled(!a.live || x.locked)
                }

                if a.live {
                    if a.steps.contains(where: { !$0.ticked }) || a.status != "agent" {
                        TextFieldLink(note.isEmpty ? "Add a note" : "Note: \(note)") { t in note = t.trimmingCharacters(in: .whitespacesAndNewlines) }
                            .font(.footnote)
                    }
                    if a.steps.contains(where: { !$0.ticked }) {
                        Button("All done") { pending = .all(note: note) }.tint(.green)
                    }
                    if a.status != "agent" {
                        Button("Ask the agent to do it") { pending = .agent(note: note) }.tint(.blue)
                    }
                }
                if !a.context.isEmpty { Text(a.context).font(.caption2).foregroundStyle(.secondary).padding(.top, 4) }
            }
        }
        .navigationTitle(a.id)
        #if DEBUG
        .task { if let op = Self.debugOp(UserDefaults.standard.string(forKey: "autoAction"), a) { send(op) } } // development: `-autoAction tick:2`
        #endif
        .confirmationDialog(pending.map(Self.question) ?? "", isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }), titleVisibility: .visible) {
            Button(pending.map(Self.verb) ?? "Send") { if let op = pending { send(op) } }
            Button("Cancel", role: .cancel) { pending = nil }
        }
        .overlay {
            if sending { ProgressView().padding().background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12)) }
            else if let result { Text(result).font(.footnote).multilineTextAlignment(.center).padding().background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12)) }
        }
    }

    private func tap(_ x: ActionStep) {
        if x.locked { return }
        pending = x.ticked ? .untick(x.n) : .tick(x.n)
    }

    private func send(_ op: ActionOp) {
        pending = nil
        sending = true
        Task {
            do {
                try await store.act(a, op)
                sending = false
                switch op {
                case .tick(let n): result = "Step \(n) ticked. The agent hears it in a minute."
                case .untick(let n): result = "Step \(n) unticked."
                case .all: result = "Sent: all done."
                case .agent: result = "Sent to the agent."
                }
                note = ""
                try? await Task.sleep(for: .seconds(1.2))
                result = nil
                if case .all = op { dismiss() }
                if case .agent = op { dismiss() }
            } catch {
                sending = false
                result = "Not sent. \(error.localizedDescription)"
                try? await Task.sleep(for: .seconds(3))
                result = nil
            }
        }
    }

    #if DEBUG
    // "tick:2", "untick:2", "all", "agent"; only when it would change something (a tick on a step still to do…)
    static func debugOp(_ s: String?, _ a: ActionItem) -> ActionOp? {
        guard let s, a.live else { return nil }
        let p = s.split(separator: ":"), n = p.count > 1 ? Int(p[1]) ?? 0 : 0
        let step = a.steps.first { $0.n == n }
        switch p.first {
        case "tick": return step?.state == "todo" ? .tick(n) : nil
        case "untick": return step?.state == "done" || step?.state == "checking" ? .untick(n) : nil
        case "all": return a.steps.contains { !$0.ticked } ? .all(note: "from the Watch") : nil
        case "agent": return a.status != "agent" ? .agent(note: "from the Watch") : nil
        default: return nil
        }
    }
    #endif

    static func question(_ op: ActionOp) -> String {
        switch op {
        case .tick(let n): return "Step \(n) done?"
        case .untick(let n): return "Untick step \(n)?"
        case .all(let note): return "Mark every step done?" + (note?.isEmpty == false ? " Note: \(note!)" : "")
        case .agent(let note): return "Ask the agent to do it?" + (note?.isEmpty == false ? " Note: \(note!)" : "")
        }
    }

    static func verb(_ op: ActionOp) -> String {
        switch op {
        case .tick: return "Tick"
        case .untick: return "Untick"
        case .all, .agent: return "Send"
        }
    }

    static func statusText(_ s: String) -> String {
        switch s {
        case "open": return "to do"
        case "agent": return "asked the agent"
        case "checking": return "the agent is checking"
        case "done": return "done"
        case "withdrawn": return "withdrawn"
        default: return s
        }
    }
}

struct StepLabel: View {
    let x: ActionStep

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: icon).foregroundStyle(color).font(.footnote)
            VStack(alignment: .leading, spacing: 3) {
                Text("\(x.n). \(x.text)").font(.footnote).multilineTextAlignment(.leading)
                if let w = x.where, !w.isEmpty { Text("Where: \(w)").font(.caption2).foregroundStyle(.secondary) }
                if let c = x.command, !c.isEmpty {
                    Text(c).font(.system(.caption2, design: .monospaced)).multilineTextAlignment(.leading)
                        .padding(4).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.gray.opacity(0.25), in: RoundedRectangle(cornerRadius: 4))
                }
                if let s = stateText { Text(s).font(.caption2).foregroundStyle(color) }
            }
            .multilineTextAlignment(.leading)
            .frame(maxWidth: .infinity, alignment: .leading)
            Spacer(minLength: 0)
        }
    }

    private var icon: String {
        switch x.state {
        case "done": return "checkmark.circle"
        case "checking": return "hourglass"
        case "verified": return "checkmark.seal.fill"
        case "skipped": return "minus.circle"
        default: return "circle"
        }
    }

    private var color: Color {
        switch x.state {
        case "done", "checking": return .blue
        case "verified": return .green
        case "skipped": return .gray
        default: return .secondary
        }
    }

    private var stateText: String? {
        let n = x.note.flatMap { $0.isEmpty ? nil : $0 }
        switch x.state {
        case "done": return "Ticked; the agent hears it in a minute"
        case "checking": return "The agent is checking" + (n.map { ": \($0)" } ?? "")
        case "verified": return "Verified" + (n.map { ": \($0)" } ?? "")
        case "skipped": return "Verify skipped" + (n.map { ": \($0)" } ?? "")
        default: return n.map { "Not done yet: \($0)" }
        }
    }
}
