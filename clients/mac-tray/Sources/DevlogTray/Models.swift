import Foundation

struct Project: Codable, Identifiable, Hashable {
    let id: Int
    let slug: String
    let name: String
    let description: String?
    let color: String?
}

enum TaskStatus: String, Codable, CaseIterable {
    case todo, today, doing, blocked, someday, done, cancelled
}

enum Priority: String, Codable, CaseIterable {
    case low, normal, high
}

struct Item: Codable, Identifiable, Hashable {
    let id: Int
    let kind: String  // "task" | "note" | "link"
    let projectId: Int
    let title: String?
    let body: String?
    let tags: [String]
    let createdAt: String
    let updatedAt: String
    let status: TaskStatus?
    let dueAt: String?
    let priority: Priority?
    let blockedReason: String?
    let doneAt: String?
    let doingStartedAt: String?
    let url: String?
    let linkDescription: String?
    let faviconUrl: String?
    let isRead: Bool

    enum CodingKeys: String, CodingKey {
        case id, kind, title, body, tags, status, priority, url
        case projectId = "project_id"
        case createdAt = "created_at"
        case updatedAt = "updated_at"
        case dueAt = "due_at"
        case blockedReason = "blocked_reason"
        case doneAt = "done_at"
        case doingStartedAt = "doing_started_at"
        case linkDescription = "link_description"
        case faviconUrl = "favicon_url"
        case isRead = "is_read"
    }
}
