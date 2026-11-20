import SwiftUI

// One decision: tap an option (or, with several questions, pick one per question), confirm, sent. Or answer in words.
struct DecisionView: View {
    @EnvironmentObject private var store: WatchStore
    @Environment(\.dismiss) private var dismiss
    let d: Decision
    @State private var pending: String?
    @State private var picks: [String: String] = [:]
    @State private var result: String?
    @State private var sending = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text("\(d.project) · \(d.id)\(d.urgent ? " · urgent" : "")").font(.caption2).foregroundStyle(d.urgent ? .red : .secondary)
                Text(d.title).font(.headline)
                if let due = d.deadlineDate {
                    (Text("Deadline ") + Text(due, style: .relative)).font(.caption2).foregroundStyle(d.urgent ? .red : .secondary)
                }
                if let last = d.lastAnswer { Text("You answered \(last.text)").font(.caption2).foregroundStyle(.secondary) }

                if d.questions.count == 1 {
                    ForEach(d.questions[0].options, id: \.value) { o in
                        Button { pending = o.value } label: { OptionLabel(o: o, on: false) }
                            .tint(o.recommended ? .green : nil)
                    }
                } else if d.questions.count > 1 {
                    ForEach(d.questions, id: \.key) { q in
                        Text("\(q.key) \(q.text)").font(.caption.weight(.semibold)).padding(.top, 4)
                        ForEach(q.options, id: \.value) { o in
                            Button { picks[q.key] = picks[q.key] == o.value ? nil : o.value } label: { OptionLabel(o: o, on: picks[q.key] == o.value) }
                        }
                    }
                    Button("Send my answers") { pending = d.questions.map { "\($0.key) \(picks[$0.key] ?? "—")" }.joined(separator: ", ") }
                        .disabled(picks.isEmpty)
                        .tint(.blue)
                }
                TextFieldLink(d.questions.isEmpty ? "Answer" : "Answer in words") { text in
                    let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !t.isEmpty { pending = t }
                }
                if !d.context.isEmpty { Text(d.context).font(.caption2).foregroundStyle(.secondary).padding(.top, 4) }
                if let n = d.ifNoAnswer { Text("If no answer: \(n)").font(.caption2).foregroundStyle(.secondary) }
            }
        }
        .navigationTitle(d.id)
        #if DEBUG
        .task { if let t = UserDefaults.standard.string(forKey: "autoAnswer"), d.lastAnswer == nil { send(t) } } // development: `-autoAnswer A`
        #endif
        .confirmationDialog("Send \(pending ?? "")?", isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }), titleVisibility: .visible) {
            Button("Send") { if let t = pending { send(t) } }
            Button("Cancel", role: .cancel) { pending = nil }
        }
        .overlay {
            if sending { ProgressView().padding().background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12)) }
            else if let result { Text(result).font(.footnote).multilineTextAlignment(.center).padding().background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12)) }
        }
    }

    private func send(_ text: String) {
        pending = nil
        sending = true
        Task {
            do {
                try await store.answer(d, text: text)
                sending = false
                result = "Saved: \(text)"
                try? await Task.sleep(for: .seconds(1.2))
                dismiss()
            } catch {
                sending = false
                result = "Not saved. \(error.localizedDescription)"
                try? await Task.sleep(for: .seconds(3))
                result = nil
            }
        }
    }
}

struct OptionLabel: View {
    let o: Option
    let on: Bool
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(o.value).font(.footnote.bold())
            Text(o.label).font(.footnote).multilineTextAlignment(.leading)
            Spacer(minLength: 0)
            if on { Image(systemName: "checkmark") } else if o.recommended { Image(systemName: "star.fill").font(.caption2) }
        }
    }
}
