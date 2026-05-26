import SwiftUI
import AppKit

@main
struct DevlogTrayApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var state = AppState()

    var body: some Scene {
        MenuBarExtra {
            MenuContent()
                .environmentObject(state)
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "checklist")
                if !state.menuBarTitle.isEmpty {
                    Text(state.menuBarTitle).font(.system(size: 12))
                }
            }
            .task { state.startPolling() }
        }
        .menuBarExtraStyle(.menu)

        Window("Capture", id: "capture") {
            CaptureWindow().environmentObject(state)
        }
        .windowResizability(.contentSize)
        .defaultPosition(.center)
    }

}

// Install a standard Edit menu so Cmd+C/V/X/Z/Shift+Z/A work in our windows even
// though we run as a LSUIElement (menu-bar-only) app and the menu is never shown.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        installEditMenu()
    }

    private func installEditMenu() {
        let main = NSMenu()

        // App submenu (required as first item).
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit Devlog",
                        action: #selector(NSApplication.terminate(_:)),
                        keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        // Edit submenu.
        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo",
                         action: Selector(("undo:")), keyEquivalent: "z")
        let redo = NSMenuItem(title: "Redo",
                              action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(redo)
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "Cut",
                         action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy",
                         action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste",
                         action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All",
                         action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        main.addItem(editItem)

        NSApp.mainMenu = main
    }
}

// Produce a compact menu label. Priority:
//   1. user-set display_label (no truncation — users picked it deliberately)
//   2. fetched title (clipped to 40 chars)
//   3. URL host
private func shortLabel(for item: Item) -> String {
    if let label = item.displayLabel?.trimmingCharacters(in: .whitespacesAndNewlines), !label.isEmpty {
        return label
    }
    let raw = (item.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if !raw.isEmpty {
        return truncate(raw, max: 40)
    }
    if let s = item.url, let host = URL(string: s)?.host {
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }
    return item.url ?? "(untitled)"
}

private func truncate(_ s: String, max: Int) -> String {
    s.count <= max ? s : String(s.prefix(max - 1)) + "…"
}

struct MenuContent: View {
    @EnvironmentObject var app: AppState
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Group {
            if !app.connected {
                Text("Backend offline").foregroundStyle(.secondary)
            } else {
                // ───── Doing — top-level (no section header) ─────
                if let d = app.doing {
                    Menu("▶ " + shortLabel(for: d)) {
                        Button("⏸ Pause (move to Today)") { app.pauseDoing(d.id) }
                        Button("✓ Mark done")            { app.markDone(d.id) }
                    }
                    Divider()
                }

                // ───── Bookmarks (per project) ─────
                if !app.bookmarksByProject.isEmpty {
                    Section("Bookmarks") {
                        ForEach(app.bookmarksByProject) { group in
                            let suffix = group.project.id == app.currentProject?.id ? " (current)" : ""
                            Menu("\(group.project.name)\(suffix) · \(group.links.count)") {
                                ForEach(group.links.prefix(25)) { link in
                                    Button(shortLabel(for: link)) {
                                        if let s = link.url, let url = URL(string: s) {
                                            NSWorkspace.shared.open(url)
                                        }
                                    }
                                }
                            }
                        }
                    }
                    Divider()
                }

                // ───── Today (per project) ─────
                if !app.todayByProject.isEmpty {
                    let totalToday = app.todayByProject.reduce(0) { $0 + $1.items.count }
                    Section("Today (\(totalToday))") {
                        ForEach(app.todayByProject) { group in
                            let suffix = group.project.id == app.currentProject?.id ? " (current)" : ""
                            Menu("\(group.project.name)\(suffix) · \(group.items.count)") {
                                ForEach(group.items.prefix(20)) { item in
                                    Menu(shortLabel(for: item)) {
                                        Button("▶ Start (mark doing)") { app.markDoing(item.id) }
                                        Button("✓ Mark done")          { app.markDone(item.id) }
                                    }
                                }
                            }
                        }
                    }
                    Divider()
                }
            }
        }

        Divider()

        Button("Capture…") {
            openWindow(id: "capture")
            NSApp.activate(ignoringOtherApps: true)
        }
        .keyboardShortcut("n")

        Button("New project…") {
            openWindow(id: "new-project")
            NSApp.activate(ignoringOtherApps: true)
        }
        Button("Open Web UI") {
            if let url = URL(string: "http://127.0.0.1:8765/") {
                NSWorkspace.shared.open(url)
            }
        }

        Divider()
        Button("Refresh") { Task { await app.refresh() } }
            .keyboardShortcut("r")
        Button("Quit Devlog") { NSApp.terminate(nil) }
            .keyboardShortcut("q")
    }
}
