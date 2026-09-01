import SwiftUI
import AppKit

@main
struct DevlogApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var state = AppState()

    var body: some Scene {
        // Main window: the full web UI in a WKWebView.
        WindowGroup("Devlog", id: "main") {
            MainWindow()
                .environmentObject(state)
                .task { await state.bootBackend() }
        }
        .defaultSize(width: 1100, height: 720)

        Settings {
            SettingsWindow().environmentObject(state)
        }

        Window("Capture", id: "capture") {
            CaptureWindow().environmentObject(state)
        }
        .windowResizability(.contentSize)
        .defaultPosition(.center)

        Window("New project", id: "new-project") {
            NewProjectWindow().environmentObject(state)
        }
        .windowResizability(.contentSize)
        .defaultPosition(.center)
    }

}

// Install a standard Edit menu so Cmd+C/V/X/Z/Shift+Z/A work in our windows.
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationDidFinishLaunching(_ notification: Notification) {
        installEditMenu()
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Tear down a managed backend so no orphan process survives the app.
        AppState.shared?.supervisor.stop()
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
