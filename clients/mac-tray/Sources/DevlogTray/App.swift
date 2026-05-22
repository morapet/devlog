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

struct MenuContent: View {
    @EnvironmentObject var app: AppState
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Group {
            if !app.connected {
                Text("Backend offline").foregroundStyle(.secondary)
            } else {
                if let d = app.doing {
                    Section("Doing") {
                        Button(action: { app.markDone(d.id) }) {
                            HStack {
                                Image(systemName: "play.fill")
                                Text(d.title ?? "(untitled)")
                                Spacer()
                                Text("✓").foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                if !app.today.isEmpty {
                    Section("Today (\(app.today.count))") {
                        ForEach(app.today.prefix(10)) { item in
                            Menu(item.title ?? "(untitled)") {
                                Button("Start (mark doing)") { app.markDoing(item.id) }
                                Button("Mark done") { app.markDone(item.id) }
                            }
                        }
                    }
                }
            }
        }

        Divider()

        Button("Capture…") {
            openWindow(id: "capture")
            NSApp.activate(ignoringOtherApps: true)
        }
        .keyboardShortcut("n")

        Menu("Project: \(app.currentProject?.name ?? "—")") {
            ForEach(app.projects) { p in
                Button(action: { app.setCurrent(p) }) {
                    HStack {
                        Text(p.name)
                        if app.currentProject?.id == p.id {
                            Spacer()
                            Image(systemName: "checkmark")
                        }
                    }
                }
            }
            if !app.projects.isEmpty { Divider() }
            Button("New project…") {
                openWindow(id: "new-project")
                NSApp.activate(ignoringOtherApps: true)
            }
            Button("Manage projects…") {
                if let url = URL(string: "http://127.0.0.1:8765/") {
                    NSWorkspace.shared.open(url)
                }
            }
        }

        Button("Open Web UI") {
            if let url = URL(string: "http://127.0.0.1:8765/") {
                NSWorkspace.shared.open(url)
            }
        }
        Button("API Docs") {
            if let url = URL(string: "http://127.0.0.1:8765/docs") {
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
