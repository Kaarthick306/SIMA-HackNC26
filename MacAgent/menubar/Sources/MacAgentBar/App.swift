import AppKit
import SwiftUI

// Claude Code is often at ~/.local/bin/claude.
private let home = FileManager.default.homeDirectoryForCurrentUser
let projectDir = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
private let claudePath = home.appendingPathComponent(".local/bin/claude").path
private let viewerURL = URL(string: "vnc://agent@127.0.0.1:\(ViewerProxy.port)")!
private let viewerProxy = ViewerProxy()

struct LogLine: Identifiable {
    enum Kind { case task, thought, action, error, result, failed, file, fileError }
    /// Where a line shows: the main window (question and answer) or one of the two log parts.
    enum Section { case main, files, actions }
    let id = UUID()
    let kind: Kind
    let text: String

    var symbol: String {
        switch kind {
        case .task: return "text.bubble"
        case .thought: return "ellipsis.bubble"
        case .action: return "cursorarrow.click"
        case .error: return "exclamationmark.triangle"
        case .result: return "checkmark.circle"
        case .failed: return "xmark.circle"
        case .file: return "doc.badge.plus"
        case .fileError: return "exclamationmark.triangle"
        }
    }

    var color: Color {
        switch kind {
        case .error, .failed, .fileError: return .orange
        case .result: return .green
        case .task, .file: return .accentColor
        default: return .secondary
        }
    }

    var section: Section {
        switch kind {
        case .task, .result, .failed: return .main
        case .file, .fileError: return .files
        case .thought, .action, .error: return .actions
        }
    }
}

/// Runs claude headlessly with mcp server and turns stream-json output into log lines.
final class AgentRunner: ObservableObject {
    @Published var log: [LogLine] = []
    @Published var isRunning = false

    private var process: Process?
    private var buffer = Data()
    /// Documents shared since the last task; mentioned to the agent with the next task.
    private var sharedSinceLastTask: [String] = []
    // For a task that came by text message: called once with the answer and whether the task ran.
    private var onFinish: ((String, Bool) -> Void)?
    private var answer: String?

    // Copy documents into the shared folder and note them in the log.
    func addFiles(_ urls: [URL]) {
        for outcome in SharedFolder.add(urls) {
            switch outcome {
            case .added(let name):
                sharedSinceLastTask.append(name)
                append(.file, name)
            case .skipped(let name, let reason):
                append(.fileError, "Couldn't add \(name): \(reason)")
            }
        }
    }

    func run(_ task: String, fromText: Bool = false, onFinish: ((String, Bool) -> Void)? = nil) {
        guard !isRunning else { return }
        append(.task, fromText ? "📱 \(task)" : task)
        self.onFinish = onFinish
        answer = nil
        var task = task
        if !sharedSinceLastTask.isEmpty {
            task += "\n\n(Files the user just shared, in \(SharedFolder.url.path): \(sharedSinceLastTask.joined(separator: ", ")))"
            sharedSinceLastTask.removeAll()
        }

        let prompt = (try? String(contentsOf: projectDir.appendingPathComponent("agent-prompt.md"), encoding: .utf8)) ?? ""
        let p = Process()
        p.executableURL = URL(fileURLWithPath: claudePath)
        p.currentDirectoryURL = projectDir
        p.arguments = [
            "-p",
            "--mcp-config", projectDir.appendingPathComponent("mcp.json").path,
            "--strict-mcp-config",
            "--tools", "",
            "--allowedTools", "mcp__mac-vnc",
            "--append-system-prompt", prompt,
            "--output-format", "stream-json",
            "--verbose",
        ]
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:\(home.path)/.local/bin:" + (env["PATH"] ?? "/usr/bin:/bin")
        p.environment = env

        // The task goes in on stdin so it can't be mistaken for a CLI flag.
        let stdin = Pipe(), stdout = Pipe(), stderr = Pipe()
        p.standardInput = stdin
        p.standardOutput = stdout
        p.standardError = stderr

        buffer = Data()
        stdout.fileHandleForReading.readabilityHandler = { [weak self] h in
            let data = h.availableData
            guard !data.isEmpty else { return }
            DispatchQueue.main.async { self?.consume(data) }
        }
        stderr.fileHandleForReading.readabilityHandler = { [weak self] h in
            let data = h.availableData
            guard !data.isEmpty, let s = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !s.isEmpty else { return }
            DispatchQueue.main.async { self?.append(.error, s) }
        }
        p.terminationHandler = { [weak self] proc in
            stdout.fileHandleForReading.readabilityHandler = nil
            stderr.fileHandleForReading.readabilityHandler = nil
            DispatchQueue.main.async {
                guard let self else { return }
                let stopped = proc.terminationReason == .uncaughtSignal
                if stopped { self.append(.failed, "Stopped.") }
                self.isRunning = false
                self.process = nil
                self.finish(stopped ? "Stopped." : self.answer ?? "The task ended without an answer.", ran: true)
            }
        }

        do {
            try p.run()
            stdin.fileHandleForWriting.write(task.data(using: .utf8)!)
            try? stdin.fileHandleForWriting.close()
            process = p
            isRunning = true
        } catch {
            append(.failed, "Couldn't start Claude at \(claudePath): \(error.localizedDescription)")
            finish("Couldn't start Claude on the Mac: \(error.localizedDescription)", ran: false)
        }
    }

    private func finish(_ text: String, ran: Bool) {
        let callback = onFinish
        onFinish = nil
        callback?(text, ran)
    }

    func stop() {
        process?.terminate()
    }

    func clear() {
        if !isRunning { log.removeAll() }
    }

    private func append(_ kind: LogLine.Kind, _ text: String) {
        log.append(LogLine(kind: kind, text: text))
    }

    private func consume(_ data: Data) {
        buffer.append(data)
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = buffer.subdata(in: buffer.startIndex..<nl)
            buffer.removeSubrange(buffer.startIndex...nl)
            if let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] {
                handle(obj)
            }
        }
    }

    private func handle(_ event: [String: Any]) {
        let content = (event["message"] as? [String: Any])?["content"] as? [[String: Any]] ?? []
        switch event["type"] as? String {
        case "assistant":
            for block in content {
                if block["type"] as? String == "text", let t = block["text"] as? String, !t.isEmpty {
                    append(.thought, t)
                } else if block["type"] as? String == "tool_use" {
                    append(.action, describe(block["name"] as? String ?? "", block["input"] as? [String: Any] ?? [:]))
                }
            }
        case "user":
            for block in content where block["type"] as? String == "tool_result" && block["is_error"] as? Bool == true {
                let text = (block["content"] as? [[String: Any]])?.compactMap { $0["text"] as? String }.joined(separator: " ")
                    ?? block["content"] as? String ?? "Tool error"
                append(.error, text)
            }
        case "result":
            var text = event["result"] as? String ?? ""
            if text.isEmpty { text = "Done." }
            answer = text
            if let cost = event["cost_usd"] as? Double, cost > 0 { text += String(format: " · $%.2f", cost) }
            append(event["is_error"] as? Bool == true ? .failed : .result, text)
        default:
            break
        }
    }

    private func describe(_ name: String, _ input: [String: Any]) -> String {
        let tool = name.replacingOccurrences(of: "mcp__mac-vnc__", with: "")
        func pt(_ key: String) -> String {
            guard let a = input[key] as? [Any], a.count == 2 else { return "the cursor" }
            return "\(a[0]), \(a[1])"
        }
        let text = input["text"] as? String ?? ""
        let mods = text.isEmpty ? "" : "\(text)+"
        switch tool {
        // Computer-use toolset
        case "screenshot": return "Looking at the screen"
        case "zoom": return "Zooming in"
        case "left_click": return "\(mods)Click at \(pt("coordinate"))"
        case "right_click": return "\(mods)Right-click at \(pt("coordinate"))"
        case "middle_click": return "\(mods)Middle-click at \(pt("coordinate"))"
        case "double_click": return "\(mods)Double-click at \(pt("coordinate"))"
        case "triple_click": return "\(mods)Triple-click at \(pt("coordinate"))"
        case "left_click_drag": return "Drag \(pt("start_coordinate")) → \(pt("coordinate"))"
        case "mouse_move": return "Move to \(pt("coordinate"))"
        case "left_mouse_down": return "Press mouse button"
        case "left_mouse_up": return "Release mouse button"
        case "cursor_position": return "Checking the cursor position"
        case "scroll": return "Scroll \(input["scroll_direction"] ?? "") at \(pt("coordinate"))"
        case "type": return "Type “\(text)”"
        case "key":
            let repeatCount = input["repeat"] as? Int ?? 1
            return "Press \(text.isEmpty ? input["combo"] as? String ?? "" : text)\(repeatCount > 1 ? " ×\(repeatCount)" : "")"
        case "hold_key": return "Hold \(text) for \(input["duration"] ?? "")s"
        case "wait": return "Wait \(input["duration"] ?? input["seconds"] ?? "")s"
        case "list_processes":
            if let days = input["older_than_days"] { return "Checking running apps (older than \(days) days)" }
            return "Checking running apps"
        case "list_my_processes":
            if let days = input["older_than_days"] { return "Checking your apps (older than \(days) days)" }
            return "Checking your apps"
        case "request_close_my_app": return "Asking you to quit PID \(input["pid"] ?? "")"
        case "list_scripts": return (input["account"] as? String) == "agent" ? "Checking the agent's scripts" : "Checking your scripts"
        case "request_stop_my_script": return "Asking you to stop PID \(input["pid"] ?? "")"
        // Older mac-vnc MCP tools
        case "click":
            let count = input["count"] as? Int ?? 1
            return "\(count == 2 ? "Double-click" : "Click") at \(input["x"] ?? ""), \(input["y"] ?? "")"
        case "move": return "Move to \(input["x"] ?? ""), \(input["y"] ?? "")"
        case "drag": return "Drag \(input["from_x"] ?? ""), \(input["from_y"] ?? "") → \(input["to_x"] ?? ""), \(input["to_y"] ?? "")"
        case "type_text": return "Type “\(text)”"
        default: return tool
        }
    }
}

struct PanelView: View {
    @EnvironmentObject var runner: AgentRunner
    @ObservedObject private var drawer = ScreenDrawer.shared
    @ObservedObject private var logDrawer = LogDrawer.shared
    @ObservedObject private var texting = IMessageBridge.shared
    @State private var task = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Button { logDrawer.toggle() } label: {
                    Label("Log", systemImage: "sidebar.left").labelStyle(.iconOnly)
                }
                .buttonStyle(AeroButtonStyle(kind: logDrawer.isOpen ? .sky : .glass))
                .help(logDrawer.isOpen ? "Hide the log" : "Show the log: files shared and agent actions")
                TextField("Tell the agent what to do…", text: $task)
                    .aeroField()
                    .focused($focused)
                    .disabled(runner.isRunning)
                    .onSubmit(submit)
                if runner.isRunning {
                    Button("Stop", action: runner.stop).keyboardShortcut(".", modifiers: .command)
                        .buttonStyle(AeroButtonStyle(kind: .stop))
                } else {
                    Button("Run", action: submit).disabled(task.trimmingCharacters(in: .whitespaces).isEmpty)
                        .buttonStyle(AeroButtonStyle(kind: .go))
                }
            }

            // Main window: only the question and the answer. Everything else is in the log.
            let main = runner.log.filter { $0.section == .main }
            if !main.isEmpty {
                LogList(lines: main, height: 200, footer: runner.isRunning ? "Working… (steps are in the Log)" : nil)
                    .padding(8)
                    .aeroGlass()
            }

            HStack {
                if runner.isRunning { ProgressView().controlSize(.small) }
                Spacer()
                Button {
                    runner.addFiles(SharedFolder.pickFiles())
                } label: {
                    Image(systemName: "paperclip")
                }
                .help("Share documents with the agent")
                Button(action: SharedFolder.openInFinder) {
                    Image(systemName: "folder")
                }
                .help("Open the shared folder")
                Button {
                    texting.toggle(askSetup: NSEvent.modifierFlags.contains(.option))
                } label: {
                    Image(systemName: "message")
                }
                .buttonStyle(AeroButtonStyle(kind: texting.enabled ? .sky : .glass))
                .help(texting.enabled
                    ? "Tasks by text message: \(texting.status). Click to turn off; ⌥-click to change the setup."
                    : "Take tasks by text message (iMessage, through Photon)")
                Button(drawer.isOpen ? "Hide" : "Watch") { drawer.toggle() }
                Button {
                    viewerProxy.start()
                    NSWorkspace.shared.open(viewerURL)
                } label: {
                    Image(systemName: "arrow.up.forward.app")
                }
                .help("Open in Screen Sharing")
                Button("Clear", action: runner.clear).disabled(runner.isRunning || runner.log.isEmpty)
                Button("Quit", action: confirmQuit)
            }
            .buttonStyle(AeroButtonStyle())
        }
        .padding(12)
        .frame(width: 560)
        .aeroText()
        .background(AeroBackground())
        // Files can also be dropped onto the panel (pasting is handled by FilePasteMonitor).
        .onAppear { FilePasteMonitor.install(runner) }
        .dropDestination(for: URL.self) { urls, _ in
            let files = urls.filter(\.isFileURL)
            runner.addFiles(files)
            return !files.isEmpty
        }
        .onAppear { focused = true }
        // The popup's view is kept between openings, so onAppear/onDisappear don't track it;
        // watch the window itself instead.
        .background(WindowVisibility { visible, window in
            if visible {
                focused = true
                ScreenDrawer.shared.popupShown(window)
                LogDrawer.shared.popupShown(window, runner: runner)
            } else {
                ScreenDrawer.shared.popupHidden()
                LogDrawer.shared.popupHidden()
            }
        })
        .onChange(of: runner.isRunning) {
            if runner.isRunning { ScreenDrawer.shared.taskStarted() }
        }
    }

    /// Ask before quitting; Cancel is the default, so Return or Esc keeps the app open.
    private func confirmQuit() {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Quit Mac Agent?"
        alert.informativeText = runner.isRunning
            ? "A task is still running. Quitting will stop it."
            : "The menu bar icon will disappear. You can reopen Mac Agent from ~/Applications."
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Quit")
        guard alert.runModal() == .alertSecondButtonReturn else { return }
        runner.stop()
        NSApp.terminate(nil)
    }

    private func submit() {
        let t = task.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, !runner.isRunning else { return }
        runner.run(t)
        task = ""
    }
}

@main
struct MacAgentBarApp: App {
    @StateObject private var runner: AgentRunner

    init() {
        let runner = AgentRunner()
        _runner = StateObject(wrappedValue: runner)
        viewerProxy.start()
        IMessageBridge.shared.attach(runner)
    }

    var body: some Scene {
        MenuBarExtra {
            PanelView().environmentObject(runner)
        } label: {
            Image(systemName: runner.isRunning ? "fish.fill" : "fish")
        }
        .menuBarExtraStyle(.window)
    }
}

/// A scrolling list of log lines that keeps the newest one in view.
struct LogList: View {
    let lines: [LogLine]
    let height: CGFloat
    var footer: String? = nil

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(lines) { line in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Image(systemName: line.symbol).foregroundStyle(line.color).frame(width: 16)
                            Text(line.text).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        }
                        .id(line.id)
                    }
                    if let footer {
                        Text(footer).font(Aero.font(11)).foregroundStyle(.secondary).id("footer")
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(height: height)
            .onChange(of: lines.count) {
                if let last = lines.last { proxy.scrollTo(last.id, anchor: .bottom) }
            }
        }
    }
}

// part of the log section witha title and its own scrolling list.
struct LogPart: View {
    let title: String
    let empty: String
    let lines: [LogLine]
    var listHeight: CGFloat = 160

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(Aero.font(11, .semibold)).foregroundStyle(Aero.deep)
            if lines.isEmpty {
                Text(empty).font(Aero.font(11)).foregroundStyle(.secondary).frame(height: listHeight, alignment: .top)
            } else {
                LogList(lines: lines, height: listHeight).font(Aero.font(11))
            }
        }
        .padding(8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .aeroGlass(cornerRadius: 8)
    }
}

/// cmd+V in the panel: if the clipboard holds files copied in Finder, add them to the shared folder;
/// otherwise let the keystroke through so text pastes into the task field as usual.
enum FilePasteMonitor {
    private static var installed = false

    static func install(_ runner: AgentRunner) {
        guard !installed else { return }
        installed = true
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak runner] event in
            guard event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
                  event.charactersIgnoringModifiers == "v",
                  let urls = NSPasteboard.general.readObjects(
                      forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL],
                  !urls.isEmpty, let runner
            else { return event }
            runner.addFiles(urls)
            return nil
        }
    }
}
