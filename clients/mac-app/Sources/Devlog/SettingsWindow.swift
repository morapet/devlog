import SwiftUI

/// Settings: choose how the app gets a backend (Managed vs Connect) and where.
struct SettingsWindow: View {
    @EnvironmentObject var app: AppState
    @ObservedObject private var settings = AppSettings.shared

    @State private var connectURL: String = AppSettings.shared.connectURLString
    @State private var portText: String = String(AppSettings.shared.managedPortPreference)
    @State private var applying = false

    var body: some View {
        Form {
            Section("Backend") {
                Picker("Mode", selection: $settings.mode) {
                    ForEach(BackendMode.allCases) { m in
                        Text(m.label).tag(m)
                    }
                }
                .pickerStyle(.radioGroup)

                switch settings.mode {
                case .connect:
                    TextField("Backend URL", text: $connectURL, prompt: Text("http://127.0.0.1:8765"))
                        .textFieldStyle(.roundedBorder)
                    Text("The app is a thin client to a backend you run yourself "
                         + "(Docker, systemd, or `uv run devlog`).")
                        .font(.caption).foregroundStyle(.secondary)
                case .managed:
                    HStack {
                        Text("Port")
                        TextField("8765", text: $portText).frame(width: 80)
                        Text("(0 = auto-pick a free port)").font(.caption).foregroundStyle(.secondary)
                    }
                    Text("The app runs its own backend with an isolated database at "
                         + "~/Library/Application Support/Devlog (seeded once from "
                         + "~/.local/share/devlog if present).")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }

            Section("Status") {
                Text(app.backendStatusText).font(.callout)
                if let url = app.baseURL {
                    Text(url.absoluteString).font(.caption.monospaced()).foregroundStyle(.secondary)
                }
            }

            HStack {
                Spacer()
                Button(applying ? "Applying…" : "Apply") { apply() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(applying)
            }
        }
        .padding(20)
        .frame(width: 460)
        .onChange(of: settings.mode) { _ in /* live-bound; applied on Apply */ }
    }

    private func apply() {
        settings.connectURLString = connectURL.trimmingCharacters(in: .whitespacesAndNewlines)
        settings.managedPortPreference = Int(portText) ?? 0
        applying = true
        Task {
            await app.applyBackendSettings()
            applying = false
        }
    }
}
