import Foundation

struct APIError: Error, LocalizedError {
    let status: Int
    let body: String
    var errorDescription: String? { "HTTP \(status): \(body)" }
}

actor APIClient {
    static let shared = APIClient()

    private let baseURL: URL
    private let session: URLSession
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    init(baseURL: URL = URL(string: "http://127.0.0.1:8765")!) {
        self.baseURL = baseURL
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 10
        cfg.waitsForConnectivity = false
        self.session = URLSession(configuration: cfg)
        self.encoder = JSONEncoder()
        self.decoder = JSONDecoder()
    }

    // MARK: low-level
    private func request<T: Decodable>(_ method: String, _ path: String, body: Encodable? = nil, as: T.Type = T.self) async throws -> T {
        var req = URLRequest(url: baseURL.appendingPathComponent(path))
        req.httpMethod = method
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try encoder.encode(AnyEncodable(body))
        }
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw APIError(status: -1, body: "no http response")
        }
        if !(200..<300).contains(http.statusCode) {
            throw APIError(status: http.statusCode, body: String(data: data, encoding: .utf8) ?? "")
        }
        if T.self == EmptyResponse.self {
            return EmptyResponse() as! T
        }
        return try decoder.decode(T.self, from: data)
    }

    // MARK: endpoints
    func health() async throws -> Bool {
        struct H: Codable { let ok: Bool }
        return (try await request("GET", "/health", as: H.self)).ok
    }

    func listProjects() async throws -> [Project] {
        try await request("GET", "/projects", as: [Project].self)
    }

    func currentProject() async throws -> Project? {
        // /projects/current/resolve returns null when not set, which decodes badly as Project
        var req = URLRequest(url: baseURL.appendingPathComponent("/projects/current/resolve"))
        req.httpMethod = "GET"
        let (data, _) = try await session.data(for: req)
        if data.isEmpty || String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespaces) == "null" {
            return nil
        }
        return try decoder.decode(Project.self, from: data)
    }

    func setCurrentProject(_ id: Int) async throws {
        _ = try await request("POST", "/projects/\(id)/current", as: EmptyResponse.self)
    }

    func createProject(slug: String, name: String, description: String? = nil, color: String? = nil) async throws -> Project {
        struct Req: Encodable { let slug: String; let name: String; let description: String?; let color: String? }
        return try await request("POST", "/projects", body: Req(slug: slug, name: name, description: description, color: color))
    }

    func listItems(projectId: Int? = nil, kind: String? = nil, status: String? = nil, limit: Int = 100) async throws -> [Item] {
        var comps = URLComponents(url: baseURL.appendingPathComponent("/items"), resolvingAgainstBaseURL: false)!
        var q: [URLQueryItem] = [URLQueryItem(name: "limit", value: String(limit))]
        if let projectId { q.append(URLQueryItem(name: "project_id", value: String(projectId))) }
        if let kind { q.append(URLQueryItem(name: "kind", value: kind)) }
        if let status { q.append(URLQueryItem(name: "status", value: status)) }
        comps.queryItems = q
        var req = URLRequest(url: comps.url!)
        req.httpMethod = "GET"
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw APIError(status: (resp as? HTTPURLResponse)?.statusCode ?? -1, body: String(data: data, encoding: .utf8) ?? "")
        }
        return try decoder.decode([Item].self, from: data)
    }

    func createTask(projectId: Int, title: String, status: TaskStatus = .todo, priority: Priority? = nil, body: String? = nil) async throws -> Item {
        struct Req: Encodable {
            let project_id: Int
            let title: String
            let status: String
            let priority: String?
            let body: String?
        }
        return try await request("POST", "/tasks", body: Req(project_id: projectId, title: title, status: status.rawValue, priority: priority?.rawValue, body: body))
    }

    func createNote(projectId: Int, title: String?, body: String) async throws -> Item {
        struct Req: Encodable { let project_id: Int; let title: String?; let body: String }
        return try await request("POST", "/notes", body: Req(project_id: projectId, title: title, body: body))
    }

    func createLink(projectId: Int, url: String, annotation: String? = nil, fetchMetadata: Bool = true) async throws -> Item {
        struct Req: Encodable {
            let project_id: Int; let url: String; let annotation: String?; let fetch_metadata: Bool
        }
        return try await request("POST", "/links", body: Req(project_id: projectId, url: url, annotation: annotation, fetch_metadata: fetchMetadata))
    }

    func markDoing(_ id: Int) async throws -> Item {
        try await request("POST", "/tasks/\(id)/doing")
    }

    func markDone(_ id: Int) async throws -> Item {
        try await request("POST", "/tasks/\(id)/done")
    }
}

struct EmptyResponse: Codable {}

private struct AnyEncodable: Encodable {
    let value: Encodable
    init(_ v: Encodable) { self.value = v }
    func encode(to encoder: Encoder) throws { try value.encode(to: encoder) }
}
