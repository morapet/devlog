import SwiftUI
import WebKit
import AppKit

/// The app's main window: a WKWebView wrapping the existing devlog web UI, so
/// the native app has full feature parity without reimplementing the frontend.
struct MainWindow: View {
    @EnvironmentObject var app: AppState

    var body: some View {
        ZStack {
            if let url = app.baseURL {
                WebView(url: url, reloadToken: app.reloadToken)
                    .ignoresSafeArea()
            } else {
                statusView
            }
        }
        .frame(minWidth: 720, minHeight: 480)
    }

    @ViewBuilder private var statusView: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text(app.backendStatusText)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 460)
            if case .failed = app.supervisor.status {
                Button("Open Settings…") { app.openSettings() }
            }
        }
        .padding(40)
    }
}

/// WKWebView that intercepts Cmd+F to open the web UI's in-note find bar. This
/// app is an accessory (agent) app with no visible menu bar, so a menu item /
/// key-equivalent is unreliable; performKeyEquivalent fires as long as the web
/// view is in the key window's view tree, whatever has focus.
final class FindableWebView: WKWebView {
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if mods == .command, event.charactersIgnoringModifiers?.lowercased() == "f" {
            evaluateJavaScript("window.openFindBar && openFindBar()")
            return true
        }
        return super.performKeyEquivalent(with: event)
    }
}

/// Minimal WKWebView bridge. Loads `url`; navigations to other origins open in
/// the system browser so the web view stays a trusted local surface.
struct WebView: NSViewRepresentable {
    let url: URL
    let reloadToken: Int

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WKWebView {
        let cfg = WKWebViewConfiguration()
        // Bridge for saving exported files: WKWebView ignores <a download>, so the
        // web UI posts {name, text} here and we present a native save panel.
        cfg.userContentController.add(context.coordinator, name: "devlogSave")
        let wv = FindableWebView(frame: .zero, configuration: cfg)
        wv.navigationDelegate = context.coordinator
        wv.uiDelegate = context.coordinator
        context.coordinator.homeOrigin = url
        // Purge any stale cache / service-worker shell (which can pin an old
        // index.html + app.js) before the first load, so the web view always
        // reflects the freshly-served UI. Cookies are kept so a Connect-mode
        // session survives. The load happens after the purge completes.
        Self.purgeWebCaches {
            wv.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
        }
        context.coordinator.loadedToken = reloadToken
        context.coordinator.loadedURL = url
        AppState.shared?.webView = wv
        return wv
    }

    static func purgeWebCaches(_ done: @escaping () -> Void) {
        let store = WKWebsiteDataStore.default()
        var types = WKWebsiteDataStore.allWebsiteDataTypes()
        types.remove(WKWebsiteDataTypeCookies)
        store.removeData(ofTypes: types, modifiedSince: .distantPast, completionHandler: done)
    }

    func updateNSView(_ wv: WKWebView, context: Context) {
        // Reload if the base URL changed (mode/port switch) or a reload was asked.
        if context.coordinator.loadedURL != url {
            context.coordinator.homeOrigin = url
            context.coordinator.loadedURL = url
            wv.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
        } else if context.coordinator.loadedToken != reloadToken {
            wv.reloadFromOrigin()
        }
        context.coordinator.loadedToken = reloadToken
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var homeOrigin: URL?
        var loadedURL: URL?
        var loadedToken: Int = 0

        func webView(_ webView: WKWebView,
                     decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let target = navigationAction.request.url else {
                decisionHandler(.allow); return
            }
            // Keep same-origin (and about:) inside the web view.
            if target.scheme == "about"
                || (target.host == homeOrigin?.host && target.port == homeOrigin?.port) {
                decisionHandler(.allow)
                return
            }
            // Everything else (external links) opens in the user's browser.
            if navigationAction.navigationType == .linkActivated {
                NSWorkspace.shared.open(target)
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        // target="_blank" / window.open() links (bookmarks and link items) arrive
        // here rather than in decidePolicyFor. WKWebView opens no new window by
        // default, so route them to the user's browser and create no web view.
        func webView(_ webView: WKWebView,
                     createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction,
                     windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let target = navigationAction.request.url {
                NSWorkspace.shared.open(target)
            }
            return nil
        }

        // MARK: - Save bridge (export downloads)

        func userContentController(_ controller: WKUserContentController,
                                   didReceive message: WKScriptMessage) {
            guard message.name == "devlogSave",
                  let body = message.body as? [String: Any],
                  let text = body["text"] as? String else { return }
            let suggested = (body["name"] as? String) ?? "devlog-export.json"
            let panel = NSSavePanel()
            panel.nameFieldStringValue = suggested
            panel.canCreateDirectories = true
            panel.begin { resp in
                guard resp == .OK, let url = panel.url else { return }
                try? text.data(using: .utf8)?.write(to: url)
            }
        }

        // MARK: - File input (import file picker)

        func webView(_ webView: WKWebView,
                     runOpenPanelWith parameters: WKOpenPanelParameters,
                     initiatedByFrame frame: WKFrameInfo,
                     completionHandler: @escaping ([URL]?) -> Void) {
            let panel = NSOpenPanel()
            panel.allowsMultipleSelection = parameters.allowsMultipleSelection
            panel.canChooseDirectories = false
            panel.canChooseFiles = true
            panel.begin { resp in
                completionHandler(resp == .OK ? panel.urls : nil)
            }
        }

        // MARK: - JS dialogs (WKWebView shows none by default)

        func webView(_ webView: WKWebView,
                     runJavaScriptAlertPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo,
                     completionHandler: @escaping () -> Void) {
            let alert = NSAlert()
            alert.messageText = message
            alert.addButton(withTitle: "OK")
            alert.runModal()
            completionHandler()
        }

        func webView(_ webView: WKWebView,
                     runJavaScriptConfirmPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo,
                     completionHandler: @escaping (Bool) -> Void) {
            let alert = NSAlert()
            alert.messageText = message
            alert.addButton(withTitle: "OK")
            alert.addButton(withTitle: "Cancel")
            completionHandler(alert.runModal() == .alertFirstButtonReturn)
        }

        func webView(_ webView: WKWebView,
                     runJavaScriptTextInputPanelWithPrompt prompt: String,
                     defaultText: String?,
                     initiatedByFrame frame: WKFrameInfo,
                     completionHandler: @escaping (String?) -> Void) {
            let alert = NSAlert()
            alert.messageText = prompt
            alert.addButton(withTitle: "OK")
            alert.addButton(withTitle: "Cancel")
            let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
            field.stringValue = defaultText ?? ""
            alert.accessoryView = field
            let ok = alert.runModal() == .alertFirstButtonReturn
            completionHandler(ok ? field.stringValue : nil)
        }
    }
}
