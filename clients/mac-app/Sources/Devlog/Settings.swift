import Foundation

/// How the app obtains a backend.
enum BackendMode: String, CaseIterable, Identifiable {
    case managed   // the app spawns & supervises a local backend
    case connect   // the app is a thin client to a backend already running
    var id: String { rawValue }
    var label: String {
        switch self {
        case .managed: return "Managed (run my own backend)"
        case .connect: return "Connect to a running backend"
        }
    }
}

/// UserDefaults-backed app configuration. Single source of truth for which
/// backend the app talks to. `AppState` observes this and rewires `APIClient`
/// and the web view whenever it changes.
@MainActor
final class AppSettings: ObservableObject {
    static let shared = AppSettings()

    private let d = UserDefaults.standard
    private enum Key {
        static let mode = "backendMode"
        static let connectURL = "connectURL"
        static let managedPort = "managedPort"   // 0 = auto-pick a free port
        static let devRepo = "devRepoPath"        // dev fallback: `uv run --directory <repo>`
    }

    @Published var mode: BackendMode {
        didSet { d.set(mode.rawValue, forKey: Key.mode) }
    }
    @Published var connectURLString: String {
        didSet { d.set(connectURLString, forKey: Key.connectURL) }
    }
    /// Preferred port for managed mode. 0 means "auto".
    @Published var managedPortPreference: Int {
        didSet { d.set(managedPortPreference, forKey: Key.managedPort) }
    }
    /// Optional path to a dev checkout, enabling the `uv run` fallback when no
    /// backend is bundled. Read once at launch; not shown in the settings UI.
    @Published var devRepoPath: String {
        didSet { d.set(devRepoPath, forKey: Key.devRepo) }
    }

    private init() {
        // Default to Connect: until a backend is bundled into the .app, Managed
        // only works from a dev checkout. Connect wraps whatever is already
        // running (e.g. http://127.0.0.1:8765) with zero setup.
        let rawMode = d.string(forKey: Key.mode) ?? BackendMode.connect.rawValue
        self.mode = BackendMode(rawValue: rawMode) ?? .connect
        self.connectURLString = d.string(forKey: Key.connectURL) ?? "http://127.0.0.1:8765"
        self.managedPortPreference = d.object(forKey: Key.managedPort) as? Int ?? 8765
        self.devRepoPath = d.string(forKey: Key.devRepo)
            ?? (ProcessInfo.processInfo.environment["DEVLOG_DEV_REPO"] ?? "")
    }

    /// The base URL the app should talk to for the current mode. For managed
    /// mode this is filled in with the actually-bound port once the supervisor
    /// starts; callers should prefer `AppState.baseURL`.
    func connectBaseURL() -> URL {
        URL(string: connectURLString) ?? URL(string: "http://127.0.0.1:8765")!
    }
}

/// Where a managed backend keeps its database. Mac-native location, isolated
/// from the Docker (`./data`) and legacy (`~/.local/share/devlog`) dirs so two
/// backends never fight over one SQLite file.
enum DataDir {
    static var managed: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("Devlog", isDirectory: true)
    }
    static var legacy: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".local/share/devlog", isDirectory: true)
    }
}
