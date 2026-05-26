import Foundation
import SwiftUI

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

    private var refreshTask: Task<Void, Never>?

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
