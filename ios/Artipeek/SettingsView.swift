import SwiftUI
import UserNotifications

struct SettingsView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var serverText = ""
    @State private var serverError = ""
    @State private var testResult = ""
    @State private var busy = false
    @State private var confirmSignOut = false
    @State private var permission: UNAuthorizationStatus = .notDetermined

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("artipeek.example.com", text: $serverText)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.go)
                        .onSubmit(saveServer)
                    if !serverError.isEmpty { Text(serverError).font(.footnote).foregroundStyle(.red) }
                    if AppModel.normalize(serverText) != model.server {
                        Button("Use this server", action: saveServer)
                    }
                } header: { Text("Server") } footer: {
                    Text("The address of your artipeek (its public link). You log in there once; the login is kept.")
                }

                Section {
                    Toggle("Notifications", isOn: Binding(get: { model.notificationsOn }, set: { on in
                        Task { await model.setNotifications(on); await readPermission() }
                    }))
                    if permission == .denied {
                        Button("Allow in iOS Settings") {
                            if let u = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(u) }
                        }
                    }
                    if !model.pushStatus.isEmpty { Text(model.pushStatus).font(.footnote).foregroundStyle(.secondary) }
                    Button {
                        busy = true
                        Task { testResult = await model.sendTestPush(); busy = false }
                    } label: {
                        HStack { Text("Send a test push"); if busy { Spacer(); ProgressView() } }
                    }
                    .disabled(busy || !model.notificationsOn)
                    if !testResult.isEmpty { Text(testResult).font(.footnote).foregroundStyle(.secondary) }
                } header: { Text("Push") } footer: {
                    Text("A push when a decision is raised, when one turns urgent (flagged, or its deadline is within 24 hours), and when an action (steps only you can do) is raised. The badge counts open decisions and actions to do.")
                }

                Section {
                    Button("Sign out", role: .destructive) { confirmSignOut = true }
                } footer: {
                    Text("Forgets the login on this device and stops its pushes.")
                }

                Section("About") {
                    LabeledContent("Version", value: Self.version)
                    LabeledContent("Push environment", value: AppModel.apsEnvironment)
                    if let t = model.deviceToken { LabeledContent("Device", value: String(t.prefix(8)) + "…") }
                }
            }
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }.disabled(model.server == nil)
                }
            }
            .confirmationDialog("Sign out of artipeek on this device?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                Button("Sign out", role: .destructive) {
                    Task { await model.signOut(); dismiss() }
                }
            }
            .task {
                serverText = Self.display(model.server)
                await readPermission()
            }
        }
        .interactiveDismissDisabled(model.server == nil)
    }

    private func saveServer() {
        serverError = ""
        if model.setServer(serverText) {
            serverText = Self.display(model.server)
            dismiss()
        } else {
            serverError = "Enter a host name like artipeek.example.com, or an https:// address."
        }
    }

    private func readPermission() async {
        permission = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    // "artipeek.example.com" for https on the usual port, else the whole address
    static func display(_ url: URL?) -> String {
        guard let url else { return "" }
        return url.scheme == "https" && url.port == nil ? (url.host ?? "") : url.absoluteString
    }

    static var version: String {
        let v = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let b = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        return "\(v) (\(b))"
    }
}
