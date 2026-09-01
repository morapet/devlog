import Foundation
import SwiftUI
import AppKit
import Combine
import WebKit

struct BookmarkGroup: Identifiable {
    let project: Project
    let links: [Item]
    var id: Int { project.id }
}

struct TaskGroup: Identifiable {
    let project: Project
    let items: [Item]
    var id: Int { project.id }
}

@MainActor
final class AppState: ObservableObject {
    @Published var projects: [Project] = []
    @Published var currentProject: Project?
    @Published var doing: Item?
    @Published var today: [Item] = []
    @Published var bookmarks: [Item] = []
    @Published var bookmarksByProject: [BookmarkGroup] = []
    @Published var todayByProject: [TaskGroup] = []
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
            let doingList = try await APIClient.shared.listItems(kind: "task", status: TaskStatus.doing.rawValue, limit: 1)
            let todayList = try await APIClient.shared.listItems(kind: "task", status: TaskStatus.today.rawValue, limit: 20)
            // All pinned links across every project — grouped per project in the menu.
            let allBookmarks = try await APIClient.shared.listItems(kind: "link", isPinned: true, limit: 200)
            var grouped: [Int: [Item]] = [:]
            for b in allBookmarks { grouped[b.projectId, default: []].append(b) }
            let currentId = current?.id
            let groups: [BookmarkGroup] = projects.compactMap { p in
                guard let links = grouped[p.id], !links.isEmpty else { return nil }
                return BookmarkGroup(project: p, links: links)
            }.sorted { a, b in
                if (a.project.id == currentId) != (b.project.id == currentId) {
                    return a.project.id == currentId
                }
                return a.project.name.localizedCompare(b.project.name) == .orderedAscending
            }

            // Group today tasks by project, current first then alphabetical.
            var todayGrouped: [Int: [Item]] = [:]
            for t in todayList { todayGrouped[t.projectId, default: []].append(t) }
            let todayGroups: [TaskGroup] = projects.compactMap { p in
                guard let items = todayGrouped[p.id], !items.isEmpty else { return nil }
                return TaskGroup(project: p, items: items)
            }.sorted { a, b in
                if (a.project.id == currentId) != (b.project.id == currentId) {
                    return a.project.id == currentId
                }
                return a.project.name.localizedCompare(b.project.name) == .orderedAscending
            }

            self.projects = projects
            self.currentProject = current
            self.doing = doingList.first
            self.today = todayList
            self.bookmarks = allBookmarks
            self.bookmarksByProject = groups
            self.todayByProject = todayGroups
            self.connected = true
            self.lastError = nil
        } catch {
            self.connected = false
            self.lastError = String(describing: error)
        }
    }

    func setCurrent(_ project: Project) {
        Task {
            try? await APIClient.shared.setCurrentProject(project.id)
            await refresh()
        }
    }

    func markDone(_ id: Int) {
        Task {
            _ = try? await APIClient.shared.markDone(id)
            await refresh()
        }
    }

    func markDoing(_ id: Int) {
        Task {
            _ = try? await APIClient.shared.markDoing(id)
            await refresh()
        }
    }

    /// Pause the currently-doing task by moving it back to 'today'.
    func pauseDoing(_ id: Int) {
        Task {
            _ = try? await APIClient.shared.markToday(id)
            await refresh()
        }
    }

    var menuBarTitle: String {
        if !connected { return "—" }
        if let d = doing, let t = d.title { return "▶ " + truncated(t, 24) }
        if !today.isEmpty { return "\(today.count) today" }
        return ""
    }

    private func truncated(_ s: String, _ n: Int) -> String {
        s.count <= n ? s : String(s.prefix(n - 1)) + "…"
    }
}
