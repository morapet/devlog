import SwiftUI

enum CaptureTab: String, CaseIterable, Identifiable {
    case task, note, link
    var id: String { rawValue }
    var label: String { rawValue.capitalized }
}

struct CaptureWindow: View {
    @EnvironmentObject var app: AppState
    @State private var tab: CaptureTab = .task
    @State private var projectId: Int?
    @State private var submitting = false
    @State private var message: String?

    // task
    @State private var taskTitle: String = ""
    @State private var taskStatus: TaskStatus = .todo
    @State private var taskPriority: Priority = .normal
    @State private var taskBody: String = ""

    // note
    @State private var noteTitle: String = ""
    @State private var noteBody: String = ""

    // link
    @State private var linkUrl: String = ""
    @State private var linkAnnotation: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Picker("", selection: $tab) {
                ForEach(CaptureTab.allCases) { t in Text(t.label).tag(t) }
            }
            .pickerStyle(.segmented)

            projectPicker

            Group {
                switch tab {
                case .task: taskForm
                case .note: noteForm
                case .link: linkForm
                }
            }

            HStack {
                if let message { Text(message).font(.caption).foregroundStyle(.secondary) }
                Spacer()
                Button("Cancel") { close() }
                    .keyboardShortcut(.cancelAction)
                Button(action: submit) {
                    if submitting { ProgressView().controlSize(.small) }
                    else { Text("Save").bold() }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!canSubmit || submitting)
            }
        }
        .padding(16)
        .frame(width: 460)
        .onAppear {
            projectId = app.currentProject?.id ?? app.projects.first?.id
        }
    }

    private var projectPicker: some View {
        HStack {
            Text("Project").frame(width: 60, alignment: .leading).foregroundStyle(.secondary)
            Picker("", selection: Binding(
                get: { projectId ?? -1 },
                set: { projectId = $0 == -1 ? nil : $0 }
            )) {
                Text("— select —").tag(-1)
                ForEach(app.projects) { p in Text(p.name).tag(p.id) }
            }
            .labelsHidden()
        }
    }

    private var taskForm: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("Title", text: $taskTitle)
                .textFieldStyle(.roundedBorder)
            HStack {
                Picker("Status", selection: $taskStatus) {
                    ForEach([TaskStatus.todo, .today, .doing, .someday, .blocked], id: \.self) {
                        Text($0.rawValue).tag($0)
                    }
                }
                Picker("Priority", selection: $taskPriority) {
                    ForEach(Priority.allCases, id: \.self) { Text($0.rawValue).tag($0) }
                }
            }
            TextEditor(text: $taskBody)
                .font(.system(.body, design: .monospaced))
                .frame(minHeight: 80)
                .border(Color.secondary.opacity(0.3))
        }
    }

    private var noteForm: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("Title (optional)", text: $noteTitle)
                .textFieldStyle(.roundedBorder)
            TextEditor(text: $noteBody)
                .font(.system(.body, design: .monospaced))
                .frame(minHeight: 160)
                .border(Color.secondary.opacity(0.3))
        }
    }

    private var linkForm: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField("https://…", text: $linkUrl)
                .textFieldStyle(.roundedBorder)
            TextField("Annotation (optional)", text: $linkAnnotation, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(2...6)
        }
    }

    private var canSubmit: Bool {
        guard projectId != nil else { return false }
        switch tab {
        case .task: return !taskTitle.trimmingCharacters(in: .whitespaces).isEmpty
        case .note: return !noteBody.trimmingCharacters(in: .whitespaces).isEmpty
        case .link:
            let s = linkUrl.trimmingCharacters(in: .whitespaces)
            return s.hasPrefix("http://") || s.hasPrefix("https://")
        }
    }

    private func submit() {
        guard let pid = projectId else { return }
        submitting = true
        message = nil
        Task {
            do {
                switch tab {
                case .task:
                    _ = try await APIClient.shared.createTask(
                        projectId: pid, title: taskTitle,
                        status: taskStatus, priority: taskPriority,
                        body: taskBody.isEmpty ? nil : taskBody
                    )
                case .note:
                    _ = try await APIClient.shared.createNote(
                        projectId: pid,
                        title: noteTitle.isEmpty ? nil : noteTitle,
                        body: noteBody
                    )
                case .link:
                    _ = try await APIClient.shared.createLink(
                        projectId: pid, url: linkUrl,
                        annotation: linkAnnotation.isEmpty ? nil : linkAnnotation
                    )
                }
                await app.refresh()
                submitting = false
                close()
            } catch {
                submitting = false
                message = "Failed: \(error.localizedDescription)"
            }
        }
    }

    private func close() {
        NSApp.keyWindow?.close()
    }
}
