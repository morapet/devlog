import Foundation
import SwiftUI
import AppKit
import Combine
import WebKit

@MainActor
final class AppState: ObservableObject {
    @Published var projects: [Project] = []
    @Published var currentProject: Project?
    @Published var lastError: String?
    @Published var connected: Bool = false

    // Backend wiring.
    static var shared: AppState?
    /// The main window's web view, so app-level actions (menu Find) can reach it.
    weak var webView: WKWebView?
    let supervisor = BackendSupervisor()
    @Published var baseURL: URL?
    /// Bumped to ask the web view to reload (e.g. after a mode/port switch).
    @Published var reloadToken: Int = 0
    private var booted = false
    private var cancellables = Set<AnyCancellable>()

    private var refreshTask: Task<Void, Never>?

    init() {
        AppState.shared = self
        // Forward supervisor changes so views observing AppState re-render.
        supervisor.objectWillChange
            .receive(on: RunLoop.main)
            .sink { [weak self] in self?.objectWillChange.send() }
            .store(in: &cancellables)
    }

    /// Resolve and connect to a backend once, at launch.
    func bootBackend() async {
        guard !booted else { return }
        booted = true
        await applyBackendSettings()
    }

    /// (Re)connect according to current settings: start a managed backend, or
    /// point at a running one. Rewires APIClient and reloads the web view.
    func applyBackendSettings() async {
        let mode = AppSettings.shared.mode
        do {
            let url: URL
            switch mode {
            case .connect:
                supervisor.stop()
                url = AppSettings.shared.connectBaseURL()
            case .managed:
                url = try await supervisor.start()
            }
            await APIClient.shared.setBaseURL(url)
            self.baseURL = url
            self.reloadToken += 1
            self.lastError = nil
            startPolling()
            await refresh()
        } catch {
            self.connected = false
            self.lastError = error.localizedDescription
            if mode == .managed { self.baseURL = nil }
        }
    }

    var backendStatusText: String {
        switch AppSettings.shared.mode {
        case .connect:
            let target = AppSettings.shared.connectURLString
            if connected { return "Connected to \(target)" }
            return "Connecting to \(target)…" + (lastError.map { "\n\($0)" } ?? "")
        case .managed:
            switch supervisor.status {
            case .stopped: return "Backend stopped."
            case .starting: return "Starting backend…"
            case .running(let p): return "Backend running on port \(p)."
            case .failed(let m): return "Backend failed to start.\n\(m)"
            }
        }
    }

    func openSettings() {
        NSApp.sendAction(Selector(("showSettingsWindow:")), to: nil, from: nil)
    }

    func startPolling() {
        refreshTask?.cancel()
        refreshTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(nanoseconds: 5_000_000_000)
            }
        }
    }

    func refresh() async {
        do {
            let projects = try await APIClient.shared.listProjects()
            let current = try await APIClient.shared.currentProject()
            self.projects = projects
            self.currentProject = current
            self.connected = true
            self.lastError = nil
        } catch {
            self.connected = false
            self.lastError = String(describing: error)
        }
    }
}
