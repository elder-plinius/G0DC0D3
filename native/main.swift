import Cocoa
import WebKit
import Quartz
import Darwin

// A small native window around the portable localhost runtime.
// This developer build is ad-hoc signed (not notarized) and requires Node 22.13+.
final class GodModeApp: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler {
    private let dictation = Dictation()
    private var previewWindow: NSPanel?
    private var window: NSWindow!
    private var webView: WKWebView!
    private var loadingView: NSView!
    private var loadingTitle: NSTextField!
    private var loadingDetail: NSTextField!
    private var progress: NSProgressIndicator!
    private var retryButton: NSButton!
    private var runtimeProcess: Process?
    private var runtimeStdinPipe: Pipe?
    private var runtimeLog: FileHandle?
    private var quitting = false
    private var connectionEpoch = 0
    private var smokeFinished = false
    private var sessionRequired = false
    private var webContentRestarts = 0
    private let environment = ProcessInfo.processInfo.environment
    private lazy var port: Int = {
        if let raw = environment["G0D_PORT"], let parsed = Int(raw), (1...65535).contains(parsed) { return parsed }
        return 4317
    }()
    private var rootURL: URL {
        let safePort = (1...65535).contains(port) ? port : 4317
        return URL(string: "http://127.0.0.1:\(safePort)")!
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        installMenu()
        buildWindow()
        connect()
        NSApp.activate(ignoringOtherApps: true)
        if environment["G0D_NATIVE_SMOKE_REPORT"] != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 25) { [weak self] in
                guard let self = self, !self.smokeFinished else { return }
                self.finishSmoke(["connected": false, "error": "Native smoke test exceeded its 25-second deadline."])
            }
        }
    }

    private func installMenu() {
        let menu = NSMenu()
        let appMenuItem = NSMenuItem()
        menu.addItem(appMenuItem)
        let appMenu = NSMenu(title: "G0DM0D3")
        appMenu.addItem(withTitle: "About G0DM0D3", action: #selector(showAbout), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide G0DM0D3", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit G0DM0D3", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu
        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        menu.addItem(editItem)
        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Show Workspace", action: #selector(showWindow), keyEquivalent: "1")
        windowMenu.addItem(withTitle: "Reload Workspace", action: #selector(reload), keyEquivalent: "r")
        windowMenu.addItem(withTitle: "Open in Browser", action: #selector(openBrowser), keyEquivalent: "")
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "Close Window", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
        windowItem.submenu = windowMenu
        menu.addItem(windowItem)
        NSApp.mainMenu = menu
        NSApp.windowsMenu = windowMenu
    }

    private func buildWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 940),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "G0DM0D3"
        window.minSize = NSSize(width: 760, height: 600)
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = NSColor(calibratedRed: 0.098, green: 0.098, blue: 0.114, alpha: 1)
        window.isReleasedWhenClosed = false
        window.center()

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.userContentController.add(self, name: "dictation")
        configuration.userContentController.add(self, name: "chooseRepository")
        configuration.userContentController.add(self, name: "quickLook")
        webView = WKWebView(frame: .zero, configuration: configuration)
        if #available(macOS 13.3, *) {
            webView.isInspectable = (environment["G0D_DEVTOOLS"] == "1")
        }
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.underPageBackgroundColor = window.backgroundColor
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.isHidden = true

        let content = NSView()
        content.wantsLayer = true
        content.layer?.backgroundColor = window.backgroundColor.cgColor
        window.contentView = content
        content.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            webView.topAnchor.constraint(equalTo: content.topAnchor),
            webView.bottomAnchor.constraint(equalTo: content.bottomAnchor)
        ])

        loadingView = NSView()
        loadingView.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(loadingView)
        NSLayoutConstraint.activate([
            loadingView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            loadingView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            loadingView.topAnchor.constraint(equalTo: content.topAnchor),
            loadingView.bottomAnchor.constraint(equalTo: content.bottomAnchor)
        ])
        let mark = NSImageView(image: NSApp.applicationIconImage)
        mark.imageScaling = .scaleProportionallyUpOrDown
        mark.widthAnchor.constraint(equalToConstant: 64).isActive = true
        mark.heightAnchor.constraint(equalToConstant: 64).isActive = true
        let wordmark = NSTextField(labelWithString: "GODMODƎ")
        wordmark.setAccessibilityLabel("GodMode")
        wordmark.font = NSFont(name: "GodModeDisplay-Bold", size: 32) ?? .systemFont(ofSize: 32, weight: .bold)
        wordmark.textColor = .labelColor
        loadingTitle = NSTextField(labelWithString: "Connecting to the local runtime")
        loadingTitle.font = NSFont.systemFont(ofSize: 15, weight: .medium)
        loadingDetail = NSTextField(wrappingLabelWithString: "Your tasks stay in the portable Node runtime. This window is a native macOS client.")
        loadingDetail.font = NSFont.systemFont(ofSize: 12)
        loadingDetail.textColor = .secondaryLabelColor
        loadingDetail.alignment = .center
        loadingDetail.maximumNumberOfLines = 12
        progress = NSProgressIndicator()
        progress.style = .spinning
        progress.controlSize = .small
        progress.startAnimation(nil)
        retryButton = NSButton(title: "Retry connection", target: self, action: #selector(retry))
        retryButton.bezelStyle = .rounded
        retryButton.isHidden = true
        let stack = NSStackView(views: [mark, wordmark, loadingTitle, loadingDetail, progress, retryButton])
        stack.orientation = .vertical
        stack.alignment = .centerX
        stack.spacing = 20
        stack.translatesAutoresizingMaskIntoConstraints = false
        loadingView.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: loadingView.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: loadingView.centerYAnchor),
            stack.widthAnchor.constraint(lessThanOrEqualToConstant: 580),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: loadingView.leadingAnchor, constant: 40),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: loadingView.trailingAnchor, constant: -40),
            loadingDetail.widthAnchor.constraint(lessThanOrEqualToConstant: 560)
        ])
        window.makeKeyAndOrderFront(nil)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, origin.protocol == "http", origin.host == "127.0.0.1", origin.port == port else { return }
        if message.name == "chooseRepository" {
            let panel = NSOpenPanel()
            panel.canChooseDirectories = true; panel.canChooseFiles = false; panel.prompt = "Choose repository"
            panel.beginSheetModal(for: window) { result in
                if result == .OK, let folder = panel.url?.path { self.emit("godcode-repository", folder) }
            }
        } else if message.name == "quickLook", let item = message.body as? [String:String], let root = item["root"], let name = item["file"] {
            let data = environment["G0D_DATA_DIR"].map { URL(fileURLWithPath:$0) } ?? FileManager.default.urls(for:.applicationSupportDirectory, in:.userDomainMask)[0].appendingPathComponent("G0DC0D3")
            let parent = data.appendingPathComponent("git-worktrees").resolvingSymlinksInPath().standardizedFileURL
            let folder = URL(fileURLWithPath: root).resolvingSymlinksInPath().standardizedFileURL
            guard UUID(uuidString:folder.lastPathComponent) != nil, folder.deletingLastPathComponent().path == parent.path else { return }
            let file = folder.appendingPathComponent(name).resolvingSymlinksInPath().standardizedFileURL
            guard file.path.hasPrefix(folder.path + "/"), file.path == folder.path + "/" + name,
                  (try? file.resourceValues(forKeys:[.isRegularFileKey]).isRegularFile) == true else { return }
            let panel = previewWindow ?? NSPanel(contentRect:NSRect(x:0,y:0,width:760,height:560), styleMask:[.titled,.closable,.resizable], backing:.buffered, defer:false)
            panel.title = file.lastPathComponent
            panel.isReleasedWhenClosed = false
            let view = QLPreviewView(frame:panel.contentView?.bounds ?? .zero, style:.normal)!
            view.autoresizingMask = [.width,.height]
            view.previewItem = file as NSURL
            panel.contentView = view
            if previewWindow == nil { panel.center() }
            previewWindow = panel
            panel.makeKeyAndOrderFront(nil)
        } else if message.name == "dictation", let body = message.body as? [String:String], let id = body["id"] {
            switch body["action"] {
            case "start":
                dictation.start { text, final, error in
                    self.emit("godcode-dictation", ["id":id, "text":text, "final":final, "error":error ?? ""] as [String:Any])
                }
            case "stop":
                if !dictation.finish() { emit("godcode-dictation", ["id":id, "text":"", "final":true] as [String:Any]) }
            case "cancel": dictation.cancel()
            default: break
            }
        }
    }
    private func emit(_ event: String, _ detail: Any) {
        guard event.range(of: "^[a-z0-9-]+$", options: .regularExpression) != nil,
              let json = try? JSONSerialization.data(withJSONObject: detail, options: [.fragmentsAllowed]),
              let raw = String(data: json, encoding: .utf8) else { return }
        let value = raw
            .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
            .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('\(event)',{detail:\(value)}))")
    }
    private enum Probe { case healthy, absent, legacy, incompatible }
    private func probe(_ completion: @escaping (Probe) -> Void) {
        var request = URLRequest(url: rootURL.appendingPathComponent("api/health"))
        request.timeoutInterval = 1.5
        request.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: request) { data, response, error in
            let result: Probe
            if error != nil { result = .absent }
            else if let http = response as? HTTPURLResponse, http.statusCode == 200,
                    let data = data,
                    let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
                    json["app"] as? String == "g0dc0d3" {
                if json["veniceCatalog"] as? Bool == true && json["authRequired"] as? Bool == true {
                    DispatchQueue.main.async { self.sessionRequired = true }
                    result = .healthy
                } else if json["desktopWorktrees"] == nil {
                    result = .legacy
                } else { result = .incompatible }
            }
            else { result = .incompatible }
            DispatchQueue.main.async { completion(result) }
        }.resume()
    }

    private func connect() {
        connectionEpoch += 1
        let epoch = connectionEpoch
        loadingView.isHidden = false
        webView.isHidden = true
        retryButton.isHidden = true
        loadingTitle.stringValue = "Connecting to the local runtime"
        loadingDetail.stringValue = "Checking \(rootURL.absoluteString). Existing tasks and provider configuration remain in the runtime."
        progress.startAnimation(nil)
        probe { [weak self] result in
            guard let self = self, self.connectionEpoch == epoch, !self.quitting else { return }
            switch result {
            case .healthy: self.openWorkspace()
            case .legacy where self.environment["G0D_PORT"] == nil && self.port == 4317:
                self.port = 4327
                self.connect()
            case .legacy, .incompatible: self.showError("Port \(self.port) is occupied", "The service on this port needs a different runtime. If the previous desktop app is open, quit it and retry, or choose another G0D_PORT.")
            case .absent:
                do { try self.launchRuntime(); self.waitForRuntime(epoch: epoch, remaining: 200) }
                catch { self.showError("The runtime could not start", error.localizedDescription) }
            }
        }
    }

    private func nodeExecutable() throws -> URL {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let candidates = [environment["G0D_NODE_BINARY"], Bundle.main.resourceURL?.appendingPathComponent("node").path,
                          "\(home)/.local/bin/node", "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
            .compactMap { $0 } + (environment["PATH"] ?? "").split(separator: ":").map { "\($0)/node" }
        var probeEnv = environment
        for unsafeKey in ["DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH", "DYLD_FALLBACK_LIBRARY_PATH", "DYLD_IMAGE_SUFFIX", "NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE"] {
            probeEnv.removeValue(forKey: unsafeKey)
        }
        for candidate in candidates where FileManager.default.isExecutableFile(atPath: candidate) {
            let check = Process()
            check.executableURL = URL(fileURLWithPath: candidate)
            check.arguments = ["--input-type=module", "-e", "import {DatabaseSync} from 'node:sqlite'; const [major,minor]=process.versions.node.split('.').map(Number); if(major<22 || (major===22 && minor<13)) process.exit(1);"]
            check.environment = probeEnv
            check.standardOutput = FileHandle.nullDevice
            check.standardError = FileHandle.nullDevice
            do { try check.run(); check.waitUntilExit(); if check.terminationStatus == 0 { return check.executableURL! } } catch { continue }
        }
        throw NSError(domain: "G0DC0D3", code: 1, userInfo: [NSLocalizedDescriptionKey: "Node.js 22.13 or newer with node:sqlite is required. Install a supported Node version, or launch with G0D_NODE_BINARY pointing to its executable. No model credentials are bundled with this app."])
    }

    private func launchRuntime() throws {
        if let process = runtimeProcess, process.isRunning { return }
        let bundled = Bundle.main.resourceURL?.appendingPathComponent("runtime")
        let adjacent = Bundle.main.bundleURL.deletingLastPathComponent().deletingLastPathComponent()
        var runtime: URL
        if let explicit = environment["G0D_PROJECT_DIR"], !explicit.isEmpty {
            runtime = URL(fileURLWithPath: explicit)
        } else if let bundled = bundled, FileManager.default.fileExists(atPath: bundled.appendingPathComponent("src/server.mjs").path) {
            runtime = bundled
        } else {
            runtime = adjacent
        }
        if !FileManager.default.fileExists(atPath: runtime.appendingPathComponent("src/server.mjs").path),
           let saved = UserDefaults.standard.string(forKey: "runtimeProject") { runtime = URL(fileURLWithPath: saved) }
        if !FileManager.default.fileExists(atPath: runtime.appendingPathComponent("src/server.mjs").path) {
            let panel = NSOpenPanel()
            panel.title = "Choose your G0DM0D3 source checkout"
            panel.canChooseDirectories = true; panel.canChooseFiles = false
            guard panel.runModal() == .OK, let selected = panel.url, FileManager.default.fileExists(atPath: selected.appendingPathComponent("src/server.mjs").path) else {
                throw NSError(domain: "G0DC0D3", code: 3, userInfo: [NSLocalizedDescriptionKey: "Choose the G0DM0D3 source folder containing src/server.mjs."])
            }
            runtime = selected
            UserDefaults.standard.set(selected.path, forKey: "runtimeProject")
        }
        let entry = runtime.appendingPathComponent("src/server.mjs")
        let defaultData = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("G0DC0D3")
        let data = environment["G0D_DATA_DIR"].map { URL(fileURLWithPath: $0) } ?? defaultData
        try FileManager.default.createDirectory(at: data, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let log = data.appendingPathComponent("native-runtime.log")
        if !FileManager.default.fileExists(atPath: log.path) { FileManager.default.createFile(atPath: log.path, contents: nil, attributes: [.posixPermissions: 0o600]) }
        runtimeLog = try FileHandle(forWritingTo: log)
        try runtimeLog?.seekToEnd()
        var processEnvironment = environment
        for unsafeKey in ["DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "DYLD_FRAMEWORK_PATH", "DYLD_FALLBACK_LIBRARY_PATH", "DYLD_IMAGE_SUFFIX", "NODE_OPTIONS", "NODE_PATH", "ELECTRON_RUN_AS_NODE"] {
            processEnvironment.removeValue(forKey: unsafeKey)
        }
        processEnvironment["DO_NOT_TRACK"] = "1"
        processEnvironment["OTEL_SDK_DISABLED"] = "true"
        processEnvironment["DISABLE_TELEMETRY"] = "1"
        processEnvironment["G0D_DATA_DIR"] = data.path
        processEnvironment["G0D_PORT"] = String(port)
        processEnvironment["TMPDIR"] = NSTemporaryDirectory()
        if processEnvironment["G0D_CODEX_BINARY"] == nil {
            let candidates = ["/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex", "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex", "/Applications/Codex.app/Contents/Resources/codex", "/Applications/ChatGPT.app/Contents/Resources/codex", "/opt/homebrew/bin/codex", "/usr/local/bin/codex"]
            processEnvironment["G0D_CODEX_BINARY"] = candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
        }
        // G0D_ENABLE_CODEX is opt-in. Existing authentication belongs to the user.
        let process = Process()
        process.executableURL = try nodeExecutable()
        guard let nativeExecutable = Bundle.main.executableURL else { throw CocoaError(.fileNoSuchFile) }
        process.arguments = [entry.path, "--native-keychain", nativeExecutable.path, "--exit-on-stdin-eof"]
        process.currentDirectoryURL = runtime
        process.environment = processEnvironment
        let stdinPipe = Pipe()
        process.standardInput = stdinPipe
        process.standardOutput = runtimeLog
        process.standardError = runtimeLog
        process.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                guard let self = self, !self.quitting else { return }
                self.connectionEpoch += 1
                self.runtimeStdinPipe = nil
                self.showError("The local runtime stopped", "Exit status \(process.terminationStatus). Its diagnostic log is at \(log.path). Retry to restart from the saved task state.")
            }
        }
        try process.run()
        runtimeStdinPipe = stdinPipe
        runtimeProcess = process
        loadingTitle.stringValue = "Starting the portable runtime"
        loadingDetail.stringValue = "Local state: \(data.path)\nIf macOS asks for Keychain access, it is only unlocking your own saved API keys on this device — click Always Allow so you won't be asked again."
    }

    private func waitForRuntime(epoch: Int, remaining: Int) {
        guard connectionEpoch == epoch, !quitting else { return }
        probe { [weak self] result in
            guard let self = self, self.connectionEpoch == epoch, !self.quitting else { return }
            if case .healthy = result {
                do {
                    let url = try self.launchURL()
                    self.openWorkspace(url)
                    return
                } catch let err as NSError where err.domain == NSCocoaErrorDomain && err.code == NSFileReadNoSuchFileError && remaining > 0 {
                    // Session token file may still be publishing right after server.listen().
                } catch {
                    self.showError("The local session could not be opened", error.localizedDescription)
                    return
                }
            }
            if remaining <= 0 { self.showError("The runtime is taking longer than expected", "Inspect native-runtime.log in the configured data directory, then retry. G0DM0D3 has not created a second server."); return }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.waitForRuntime(epoch: epoch, remaining: remaining - 1) }
        }
    }

    private func openWorkspace(_ resolvedURL: URL? = nil) {
        do {
            // A changed session fragment alone is same-document navigation in
            // WebKit: it does not re-run bootstrap or call didFinish. Give each
            // connection its own document URL so Retry actually reconnects.
            let target = try resolvedURL ?? launchURL()
            var components = URLComponents(url: target, resolvingAgainstBaseURL: false)!
            components.queryItems = [URLQueryItem(name: "desktopConnection", value: UUID().uuidString)]
            progress.stopAnimation(nil)
            webView.load(URLRequest(url: components.url!, cachePolicy: .reloadIgnoringLocalCacheData))
        } catch { showError("The local session could not be opened", error.localizedDescription) }
    }

    // This capability never enters project workspaces. Same-user host processes
    // remain trusted; task command sandboxes cannot read this directory.
    private func launchURL() throws -> URL {
        if !sessionRequired { return rootURL }
        let directory = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("g0dc0d3-sessions-\(getuid())")
        let file = directory.appendingPathComponent("\(port).json")
        for (url, expectedType, mask) in [(directory, FileAttributeType.typeDirectory, 0o077), (file, FileAttributeType.typeRegular, 0o177)] {
            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
            guard attributes[.type] as? FileAttributeType == expectedType,
                  (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
                  let mode = attributes[.posixPermissions] as? NSNumber,
                  mode.intValue & mask == 0 else {
                throw NSError(domain: "G0DC0D3", code: 4, userInfo: [NSLocalizedDescriptionKey: "The owner-only session file has unexpected permissions. Restart the local runtime."])
            }
        }
        let data = try Data(contentsOf: file)
        guard let record = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              record["port"] as? Int == port, let token = record["token"] as? String,
              token.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil else {
            throw NSError(domain: "G0DC0D3", code: 5, userInfo: [NSLocalizedDescriptionKey: "The local session file is invalid. Restart the local runtime."])
        }
        var components = URLComponents(url: rootURL, resolvingAgainstBaseURL: false)!
        components.fragment = "session=\(token)"
        return components.url!
    }

    private func showError(_ title: String, _ detail: String) {
        loadingTitle.stringValue = title
        loadingDetail.stringValue = detail
        loadingView.isHidden = false
        webView.isHidden = true
        progress.stopAnimation(nil)
        retryButton.isHidden = false
        if environment["G0D_NATIVE_SMOKE_REPORT"] != nil { finishSmoke(["connected": false, "error": "\(title): \(detail)"]) }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        let epoch = connectionEpoch
        webView.evaluateJavaScript("!!document.getElementById('composer-input')") { [weak self] value, error in
            guard let self = self, self.connectionEpoch == epoch, !self.quitting else { return }
            guard error == nil, value as? Bool == true else { self.recoverWebContent(); return }
            self.loadingView.isHidden = true
            webView.isHidden = false
            if self.environment["G0D_NATIVE_SMOKE_REPORT"] != nil { self.checkSmokePage(remaining: 32) }
        }
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        recoverWebContent()
    }
    private func recoverWebContent() {
        guard !quitting else { return }
        // Recover once without restarting the runtime or disturbing its tasks.
        guard webContentRestarts < 1 else {
            showError("The workspace view could not stay open", "The local runtime and saved chats remain intact. Retry to reload the window.")
            return
        }
        webContentRestarts += 1
        connect()
    }
    private func checkSmokePage(remaining: Int) {
        guard !smokeFinished else { return }
        webView.evaluateJavaScript("JSON.stringify({title:document.title,url:location.origin+location.pathname,sessionFragmentCleared:!location.hash,connected:!!document.querySelector('#connection.online'),workspaceReady:!!document.querySelector('#initial-loading.hidden') && (!!document.querySelector('#task-workspace:not(.hidden)') || !!document.querySelector('#welcome:not(.hidden)')),ready:document.readyState})") { [weak self] value, error in
            guard let self = self, !self.smokeFinished else { return }
            var report = [String: Any]()
            if let text = value as? String, let data = text.data(using: .utf8),
               let result = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] { report = result }
            if report["connected"] as? Bool == true && report["workspaceReady"] as? Bool == true {
                report["nativeHost"] = "AppKit/WKWebView"
                report["ownedRuntime"] = self.runtimeProcess?.isRunning ?? false
                if let folder = self.environment["G0D_NATIVE_SMOKE_PROJECT"] {
                    self.checkWorktreeUI(folder, report: report)
                } else { self.finishSmoke(report) }
            } else if remaining <= 0 {
                self.finishSmoke(["connected": false, "error": error?.localizedDescription ?? "The workspace did not report an online runtime.", "observed": report])
            } else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.checkSmokePage(remaining: remaining - 1) }
            }
        }
    }
    private func checkWorktreeUI(_ folder: String, report: [String: Any]) {
        let exercise = """
        const el = id => document.getElementById(id);
        async function until(test) {
          for (let n=0;n<100;n++) { if(test())return; await new Promise(r=>setTimeout(r,60)); }
          throw Error(el('tree-status').textContent || 'Timed out waiting for the worktree UI');
        }
        el('open-worktrees').click();
        await until(()=>el('tree-dialog').open && !el('tree-new').disabled);
        el('tree-new').click(); el('tree-folder').value=folder; el('tree-open-form').requestSubmit();
        await until(()=>!el('tree-workspace').hidden && !el('tree-new').disabled);
        async function inspect(file, selector) {
          el('tree-filter').value=file;
          el('tree-filter').dispatchEvent(new Event('input'));
          const control=Array.from(el('tree-files').querySelectorAll('button')).find(b=>b.dataset.view===file);
          if(!control)throw Error('Missing '+file);
          control.click(); await until(()=>el('tree-preview').querySelector(selector));
        }
        await inspect('public/index.html','iframe');
        await inspect('bench/README.md','h3');
        await inspect('src/server.mjs','pre');
        el('tree-files').querySelector('input').click();
        const nativeInput=!!window.webkit.messageHandlers.dictation && !!el('tree-build-form').querySelector('[data-dictate]');
        return {renderedHTML:true,renderedMarkdown:true,renderedSource:true,selected:el('tree-selection').textContent,nativeInput,branch:el('tree-status').textContent};
        """
        webView.callAsyncJavaScript(exercise, arguments: ["folder":folder], in: nil, in: .page) { result in
            var details = report
            switch result {
            case .success(let value): details["worktreeUI"] = value
            case .failure(let error): details["worktreeUIError"] = error.localizedDescription
            }
            self.finishSmoke(details)
        }
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.navigationType == .linkActivated,
           let url = navigationAction.request.url,
           ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
            NSWorkspace.shared.open(url)
        }
        return nil
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        guard frame.isMainFrame, frame.securityOrigin.protocol == "http", frame.securityOrigin.host == "127.0.0.1", frame.securityOrigin.port == port else { completionHandler(); return }
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        guard frame.isMainFrame, frame.securityOrigin.protocol == "http", frame.securityOrigin.host == "127.0.0.1", frame.securityOrigin.port == port else { completionHandler(nil); return }
        let alert = NSAlert()
        alert.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 280, height: 24))
        field.stringValue = defaultText ?? ""
        alert.accessoryView = field
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { response in completionHandler(response == .alertFirstButtonReturn ? field.stringValue : nil) }
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        guard frame.isMainFrame, frame.securityOrigin.protocol == "http", frame.securityOrigin.host == "127.0.0.1", frame.securityOrigin.port == port else { completionHandler(false); return }
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "Continue")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { response in completionHandler(response == .alertFirstButtonReturn) }
    }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard frame.isMainFrame, frame.securityOrigin.protocol == "http", frame.securityOrigin.host == "127.0.0.1", frame.securityOrigin.port == port else { completionHandler(nil); return }
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { result in
            completionHandler(result == .OK ? panel.urls : nil)
        }
    }
    private func finishSmoke(_ report: [String: Any]) {
        guard !smokeFinished, let reportPath = environment["G0D_NATIVE_SMOKE_REPORT"], reportPath.hasPrefix("/") else { return }
        smokeFinished = true
        let saveAndQuit: ([String: Any]) -> Void = { result in
            do {
                let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
                try data.write(to: URL(fileURLWithPath: reportPath), options: .atomic)
            } catch { NSLog("Native smoke report could not be written: %@", error.localizedDescription) }
            NSApp.terminate(nil)
        }
        guard report["connected"] as? Bool == true,
              let screenshot = environment["G0D_NATIVE_SMOKE_SCREENSHOT"], screenshot.hasPrefix("/") else { saveAndQuit(report); return }
        webView.takeSnapshot(with: nil) { image, error in
            var result = report
            do {
                if let tiff = image?.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
                   let png = bitmap.representation(using: .png, properties: [:]) {
                    try png.write(to: URL(fileURLWithPath: screenshot), options: .atomic)
                    result["screenshot"] = screenshot
                } else { result["screenshotError"] = error?.localizedDescription ?? "No image returned." }
            } catch { result["screenshotError"] = error.localizedDescription }
            saveAndQuit(result)
        }
    }
    private func isIgnoredNavigationError(_ error: Error) -> Bool {
        let ns = error as NSError
        return (ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled)
            || (ns.domain == "WebKitErrorDomain" && ns.code == 102)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard !isIgnoredNavigationError(error) else { return }
        showError("The workspace could not load", error.localizedDescription)
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard !isIgnoredNavigationError(error) else { return }
        showError("The workspace could not load", error.localizedDescription)
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        let scheme = url.scheme?.lowercased() ?? ""
        if scheme == "file" { decisionHandler(.cancel); return }
        if navigationAction.targetFrame?.isMainFrame == false {
            if ["about", "blob"].contains(scheme) { decisionHandler(.allow); return }
            if scheme == "http" && url.host == "127.0.0.1" && url.port == port && url.path.hasPrefix("/preview/") {
                decisionHandler(.allow); return
            }
            decisionHandler(.cancel); return
        }
        if scheme == "blob" && navigationAction.shouldPerformDownload { decisionHandler(.download); return }
        let local = scheme == "http" && url.host == "127.0.0.1" && url.port == port
        if local { decisionHandler(navigationAction.shouldPerformDownload ? .download : .allow) }
        else {
            if navigationAction.navigationType == .linkActivated && ["http", "https"].contains(scheme) { NSWorkspace.shared.open(url) }
            decisionHandler(.cancel)
        }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        if let response = navigationResponse.response as? HTTPURLResponse,
           response.value(forHTTPHeaderField: "Content-Disposition")?.lowercased().contains("attachment") == true { decisionHandler(.download) }
        else { decisionHandler(.allow) }
    }
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let baseName = URL(fileURLWithPath: suggestedFilename).lastPathComponent
        let sanitized = baseName
            .replacingOccurrences(of: "[^A-Za-z0-9._ -]", with: "_", options: .regularExpression)
            .replacingOccurrences(of: "^\\.+", with: "", options: .regularExpression)
        let safeFilename = sanitized.isEmpty ? "g0dm0d3-export.txt" : String(sanitized.prefix(180))
        let panel = NSSavePanel()
        let isBackup = safeFilename.hasPrefix("g0dc0d3-backup-")
        let isPatch = safeFilename.hasSuffix(".patch")
        panel.title = isBackup ? "Save original-file backup" : isPatch ? "Save project patch" : "Export G0DM0D3 chat history"
        panel.message = isBackup ? "This backup contains original and applied source text for recovery. Choose where to save it." : isPatch ? "Review this patch before applying it to a project. Choose where to save it." : "This ledger can contain source code and tool results. Choose where to save it."
        panel.nameFieldStringValue = safeFilename
        panel.canCreateDirectories = true
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.url : nil) }
    }
    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let ns = error as NSError
        guard !(ns.domain == NSURLErrorDomain && ns.code == NSURLErrorCancelled) else { return }
        let alert = NSAlert()
        alert.messageText = "The export could not be saved"
        alert.informativeText = error.localizedDescription
        alert.beginSheetModal(for: window)
    }

    @objc private func retry() { webContentRestarts = 0; connect() }
    @objc private func showWindow() { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    @objc private func reload() { webContentRestarts = 0; connect() }
    @objc private func openBrowser() {
        do { NSWorkspace.shared.open(try launchURL()) }
        catch { showError("The local session could not be opened", error.localizedDescription) }
    }
    @objc private func showAbout() {
        let alert = NSAlert()
        alert.messageText = "G0DM0D3 0.2.0"
        alert.informativeText = "Local developer alpha\n\nNative AppKit/WKWebView client with a portable Node.js runtime. Ad-hoc signed, not notarized. Node 22.13+ is required. Project commands use an experimental macOS filesystem/network boundary; detached process cleanup is best effort.\n\nScripted fault checks and live model results are labeled separately."
        alert.beginSheetModal(for: window)
    }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool { showWindow(); return true }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        quitting = true
        connectionEpoch += 1
        guard let process = runtimeProcess, process.isRunning else { return .terminateNow }
        // An attached server belongs to its original launcher and is left running.
        process.terminate()
        awaitTermination(process, attempts: 40)
        return .terminateLater
    }
    private func awaitTermination(_ process: Process, attempts: Int) {
        if !process.isRunning { NSApp.reply(toApplicationShouldTerminate: true); return }
        if attempts <= 0 { kill(process.processIdentifier, SIGKILL); NSApp.reply(toApplicationShouldTerminate: true); return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { self.awaitTermination(process, attempts: attempts - 1) }
    }
}

if CommandLine.arguments.dropFirst().first == "--provider-keychain" {
    exit(providerKeychain(CommandLine.arguments))
}
let app = NSApplication.shared
let delegate = GodModeApp()
app.delegate = delegate
app.run()
