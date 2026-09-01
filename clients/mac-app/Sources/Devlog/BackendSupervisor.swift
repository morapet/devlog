import Foundation

/// Spawns and babysits a local devlog backend for Managed mode.
///
/// Not a container: the backend is a plain process the app owns. The supervisor
/// picks a port, ensures the data dir, launches the backend, waits for /health,
/// restarts it on unexpected exit, and tears it down on quit.
@MainActor
final class BackendSupervisor: ObservableObject {
    enum Status: Equatable {
        case stopped
        case starting
        case running(port: Int)
        case failed(String)
    }

    @Published private(set) var status: Status = .stopped
    /// Tail of the backend's stdout/stderr, for surfacing startup failures.
    @Published private(set) var lastLog: String = ""

    private var process: Process?
    private var logPipe: Pipe?
    private var intentionalStop = false
    private var restartCount = 0
    private let maxRestarts = 5

    /// Start (or restart) the managed backend. Returns the bound base URL on
    /// success. Throws with a readable message on failure.
    @discardableResult
    func start() async throws -> URL {
        stopProcess(intentional: true)
        intentionalStop = false
        status = .starting

        let dataDir = DataDir.managed
        try prepareDataDir(dataDir)

        let pref = AppSettings.shared.managedPortPreference
        let port = try Self.resolvePort(preferred: pref)

        let (exe, args) = try resolveBackendCommand(port: port)

        let proc = Process()
        proc.executableURL = exe
        proc.arguments = args

        var env = ProcessInfo.processInfo.environment
        env["DEVLOG_DATA_DIR"] = dataDir.path
        env["DEVLOG_HOST"] = "127.0.0.1"
        env["DEVLOG_PORT"] = String(port)
        // GUI apps launch with a minimal PATH; add the usual homebrew/uv spots
        // so a `uv`-based dev launch can find its tools.
        let extra = ["/opt/homebrew/bin", "/usr/local/bin",
                     FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin").path]
        env["PATH"] = (extra + [env["PATH"] ?? "/usr/bin:/bin"]).joined(separator: ":")
        proc.environment = env

        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = pipe
        self.logPipe = pipe
        pipe.fileHandleForReading.readabilityHandler = { [weak self] h in
            let chunk = h.availableData
            guard !chunk.isEmpty, let s = String(data: chunk, encoding: .utf8) else { return }
            Task { @MainActor in self?.appendLog(s) }
        }

        proc.terminationHandler = { [weak self] p in
            Task { @MainActor in self?.handleExit(status: p.terminationStatus) }
        }

        do {
            try proc.run()
        } catch {
            status = .failed("Could not launch backend: \(error.localizedDescription)")
            throw error
        }
        self.process = proc

        // Wait for readiness.
        let ok = await waitForHealth(port: port, timeout: 20)
        if !ok {
            let tail = lastLog.isEmpty ? "(no output)" : lastLog
            stopProcess(intentional: true)
            status = .failed("Backend did not become healthy on port \(port).\n\(tail)")
            throw SupervisorError.unhealthy(tail)
        }

        restartCount = 0
        status = .running(port: port)
        return URL(string: "http://127.0.0.1:\(port)")!
    }

    /// Stop the backend for good (called on app quit).
    func stop() {
        stopProcess(intentional: true)
        status = .stopped
    }

    // MARK: - internals

    private func appendLog(_ s: String) {
        lastLog = String((lastLog + s).suffix(4000))
    }

    private func handleExit(status code: Int32) {
        logPipe?.fileHandleForReading.readabilityHandler = nil
        process = nil
        if intentionalStop { return }
        // Unexpected exit — try to restart with backoff.
        guard restartCount < maxRestarts else {
            status = .failed("Backend exited (code \(code)) and exceeded restart attempts.\n\(lastLog)")
            return
        }
        restartCount += 1
        let delay = min(pow(2.0, Double(restartCount - 1)), 8)
        status = .starting
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            if !intentionalStop { _ = try? await start() }
        }
    }

    private func stopProcess(intentional: Bool) {
        intentionalStop = intentional
        logPipe?.fileHandleForReading.readabilityHandler = nil
        if let p = process, p.isRunning {
            p.terminate()
            // Give it a moment, then hard-kill if still alive.
            let pid = p.processIdentifier
            DispatchQueue.global().asyncAfter(deadline: .now() + 2) {
                if p.isRunning { kill(pid, SIGKILL) }
            }
        }
        process = nil
    }

    private func prepareDataDir(_ dir: URL) throws {
        let fm = FileManager.default
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        // One-time seed: if the managed DB doesn't exist yet but a legacy DB
        // does, copy it so the user isn't starting empty. Never overwrite.
        let managedDB = dir.appendingPathComponent("devlog.db")
        let legacyDB = DataDir.legacy.appendingPathComponent("devlog.db")
        if !fm.fileExists(atPath: managedDB.path), fm.fileExists(atPath: legacyDB.path) {
            try? fm.copyItem(at: legacyDB, to: managedDB)
        }
    }

    /// Resolve the executable + args to run the backend.
    private func resolveBackendCommand(port: Int) throws -> (URL, [String]) {
        let host = "127.0.0.1"
        // 1) Bundled sidecar (future): Resources/backend/bin/devlog
        if let res = Bundle.main.resourceURL {
            let bundled = res.appendingPathComponent("backend/bin/devlog")
            if FileManager.default.isExecutableFile(atPath: bundled.path) {
                return (bundled, ["--host", host, "--port", String(port)])
            }
        }
        // 2) Dev checkout via uv: uv run --directory <repo> devlog
        let repo = AppSettings.shared.devRepoPath
        if !repo.isEmpty, let uv = Self.locate("uv") {
            return (uv, ["run", "--directory", repo, "devlog", "--host", host, "--port", String(port)])
        }
        throw SupervisorError.noBackend
    }

    /// Find a usable port: try `preferred` (or auto if 0), else ask the OS.
    static func resolvePort(preferred: Int) throws -> Int {
        if preferred > 0, isPortFree(preferred) { return preferred }
        if let p = freePort() { return p }
        throw SupervisorError.noPort
    }

    static func isPortFree(_ port: Int) -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        if fd < 0 { return false }
        defer { close(fd) }
        var yes: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = in_port_t(port).bigEndian
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        return bound == 0
    }

    static func freePort() -> Int? {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        if fd < 0 { return nil }
        defer { close(fd) }
        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        if bound != 0 { return nil }
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let got = withUnsafeMutablePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                getsockname(fd, $0, &len)
            }
        }
        if got != 0 { return nil }
        return Int(UInt16(bigEndian: addr.sin_port))
    }

    static func locate(_ tool: String) -> URL? {
        let candidates = [
            "/opt/homebrew/bin/\(tool)",
            "/usr/local/bin/\(tool)",
            FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".local/bin/\(tool)").path,
        ]
        for c in candidates where FileManager.default.isExecutableFile(atPath: c) {
            return URL(fileURLWithPath: c)
        }
        return nil
    }

    private func waitForHealth(port: Int, timeout: TimeInterval) async -> Bool {
        let url = URL(string: "http://127.0.0.1:\(port)/health")!
        let deadline = Date().addingTimeInterval(timeout)
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 2
        let session = URLSession(configuration: cfg)
        while Date() < deadline {
            if intentionalStop { return false }
            do {
                let (_, resp) = try await session.data(from: url)
                if let http = resp as? HTTPURLResponse, http.statusCode == 200 { return true }
            } catch {
                // not up yet
            }
            try? await Task.sleep(nanoseconds: 400_000_000)
        }
        return false
    }
}

enum SupervisorError: LocalizedError {
    case noBackend
    case noPort
    case unhealthy(String)

    var errorDescription: String? {
        switch self {
        case .noBackend:
            return "No backend found. Bundle one into the app, or set a dev repo "
                + "path (DEVLOG_DEV_REPO) so it can run via `uv`, or switch to "
                + "Connect mode in Settings."
        case .noPort:
            return "Could not find a free TCP port to run the backend."
        case .unhealthy(let tail):
            return "Backend failed to start:\n\(tail)"
        }
    }
}
