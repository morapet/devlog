import SwiftUI

struct NewProjectWindow: View {
    @EnvironmentObject var app: AppState
    @Environment(\.dismiss) private var dismiss

    @State private var slug = ""
    @State private var name = ""
    @State private var description = ""
    @State private var color: Color = .gray
    @State private var submitting = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("New project").font(.headline)

            field("Slug", help: "lowercase, no spaces (e.g. devlog, work-stuff)") {
                TextField("lowercase-slug", text: $slug)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(.body, design: .monospaced))
            }

            field("Name") {
                TextField("Display name", text: $name)
                    .textFieldStyle(.roundedBorder)
                    .onChange(of: name) { new in
                        if slug.isEmpty { slug = slugify(new) }
                    }
            }

            field("Description") {
                TextField("Optional", text: $description, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(2...4)
            }

            HStack {
                Text("Color").foregroundStyle(.secondary).font(.caption)
                ColorPicker("", selection: $color, supportsOpacity: false)
                    .labelsHidden()
                    .frame(width: 40)
                Spacer()
            }

            if let error {
                Text(error).foregroundStyle(.red).font(.caption)
            }

            HStack {
                Spacer()
                Button("Cancel") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button {
                    submit()
                } label: {
                    if submitting { ProgressView().controlSize(.small) }
                    else { Text("Create").bold() }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!canSubmit || submitting)
            }
        }
        .padding(16)
        .frame(width: 380)
    }

    @ViewBuilder
    private func field<Content: View>(_ label: String, help: String? = nil, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label.uppercased())
                .font(.caption2)
                .foregroundStyle(.secondary)
                .tracking(0.5)
            content()
            if let help {
                Text(help).font(.caption2).foregroundStyle(.secondary)
            }
        }
    }

    private var canSubmit: Bool {
        let s = slug.trimmingCharacters(in: .whitespaces)
        let n = name.trimmingCharacters(in: .whitespaces)
        if s.isEmpty || n.isEmpty { return false }
        return s.range(of: "^[a-z0-9][a-z0-9-]*$", options: .regularExpression) != nil
    }

    private func slugify(_ s: String) -> String {
        let lower = s.lowercased()
        let allowed = Set("abcdefghijklmnopqrstuvwxyz0123456789-")
        var out = ""
        var lastDash = false
        for ch in lower {
            if allowed.contains(ch) {
                out.append(ch)
                lastDash = ch == "-"
            } else if ch == " " || ch == "_" {
                if !lastDash && !out.isEmpty { out.append("-"); lastDash = true }
            }
        }
        while out.hasSuffix("-") { out.removeLast() }
        return out
    }

    private func submit() {
        submitting = true
        error = nil
        Task {
            do {
                let hex = color.hex ?? "#64748b"
                _ = try await APIClient.shared.createProject(
                    slug: slug.trimmingCharacters(in: .whitespaces),
                    name: name.trimmingCharacters(in: .whitespaces),
                    description: description.isEmpty ? nil : description,
                    color: hex
                )
                await app.refresh()
                submitting = false
                dismiss()
            } catch {
                submitting = false
                self.error = (error as? APIError)?.body ?? error.localizedDescription
            }
        }
    }
}

extension Color {
    var hex: String? {
        #if canImport(AppKit)
        let ns = NSColor(self).usingColorSpace(.deviceRGB)
        guard let ns else { return nil }
        let r = Int((ns.redComponent * 255).rounded())
        let g = Int((ns.greenComponent * 255).rounded())
        let b = Int((ns.blueComponent * 255).rounded())
        return String(format: "#%02x%02x%02x", r, g, b)
        #else
        return nil
        #endif
    }
}
