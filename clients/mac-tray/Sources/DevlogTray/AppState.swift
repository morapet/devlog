import Foundation
import SwiftUI

@MainActor
final class AppState: ObservableObject {
    @Published var projects: [Project] = []
    @Published var currentProject: Project?
    @Published var doing: Item?
    @Published var today: [Item] = []
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
            self.projects = projects
            self.currentProject = current
            self.doing = doingList.first
            self.today = todayList
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
