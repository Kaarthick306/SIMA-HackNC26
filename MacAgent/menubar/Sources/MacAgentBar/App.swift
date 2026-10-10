//important info: Claude Code is at ~/.local/bin/claude.

import AppKit
import SwiftUI

private let home = FileManager.default.homeDirectoryForCurrentUser
private let projectDir = home.appendingPathComponent("mac-agent")
private let claudePath = home.appendingPathComponent(".local/bin/claude").path

//localhost screen sharing server, force unwraps incase of invalid string
private let viewerURL = URL(string: "vnc://agent@127.0.0.1:\(ViewerProxy.port)")!
private let viewerProxy = ViewerProxy()

struct LogLine: Identifiable {
    enum Kind { case task, thought, action, error, result }
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
        }
    }

    var color: Color {
        switch kind {
            case .error: return .orange
            case .result: return .green
            case .task: return .accentColor
        default: return .secondary
        }
    }
}

//Run claude headlessly with mac vnc turn its stream.json into logs
final class AgentRunner: ObservableObject {
    @Published var log: [LogLine] = []
    @Published var isRunning = false

    private var process: Process?
    private var buffer = Data()

    func run(_ task: String) {
        guard !isRunning else { return }
        append(.task, task)

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
                if proc.terminationReason == .uncaughtSignal { self.append(.error, "Stoped.") }
                self.isRunning = false
                self.process = nil
            }
        }

        do {
            try p.run()
            stdin.fileHandleForWriting.write(task.data(using: .utf8)!)
            try? stdin.fileHandleForWriting.close()
            process = p
            isRunning = true
        } catch {
            append(.error, "Couldn't start Claude at \(claudePath): \(error.localizedDescription)")
        }
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
            let text = event["result"] as? String ?? ""
            append(event["is_error"] as? Bool == true ? .error : .result, text.isEmpty ? "Done." : text)
        default:
            break
        }
    }

    private func describe(_ name: String, _ input: [String: Any]) -> String {
        let tool = name.replacingOccurrences(of: "mcp__mac-vnc__", with: "")
        let x = input["x"] ?? "", y = input["y"] ?? ""
        switch tool {
        case "screenshot": return "Looking at the screen"
        case "click":
            let count = input["count"] as? Int ?? 1
            return "\(count == 2 ? "Double-click" : "Click") at \(x), \(y)"
        case "move": return "Move to \(x), \(y)"
        case "drag": return "Drag \(input["from_x"] ?? ""), \(input["from_y"] ?? "") → \(input["to_x"] ?? ""), \(input["to_y"] ?? "")"
        case "type_text": return "Type “\(input["text"] as? String ?? "")”"
        case "key": return "Press \(input["combo"] as? String ?? "")"
        case "scroll": return "Scroll \(input["direction"] ?? "") at \(x), \(y)"
        case "wait": return "Wait \(input["seconds"] ?? "")s"
        default: return tool
        }
    }
}

struct PanelView: View {
    @EnvironmentObject var runner: AgentRunner
    @ObservedObject private var drawer = ScreenDrawer.shared
    @State private var task = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                TextField("Tell the agent what to do…", text: $task)
                    .textFieldStyle(.roundedBorder)
                    .focused($focused)
                    .disabled(runner.isRunning)
                    .onSubmit(submit)
                if runner.isRunning {
                    Button("Stop", action: runner.stop).keyboardShortcut(".", modifiers: .command)
                } else {
                    Button("Run", action: submit).disabled(task.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }

            if !runner.log.isEmpty {
                ScrollViewReader { proxy in
                    ScrollView {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(runner.log) { line in
                                HStack(alignment: .firstTextBaseline, spacing: 6) {
                                    Image(systemName: line.symbol).foregroundStyle(line.color).frame(width: 16)
                                    Text(line.text).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                                }
                                .id(line.id)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(height: 220)
                    .onChange(of: runner.log.count) {
                        if let last = runner.log.last { proxy.scrollTo(last.id, anchor: .bottom) }
                    }
                }
            }

            HStack {
                if runner.isRunning { ProgressView().controlSize(.small) }
                Spacer()
                Button(drawer.isOpen ? "Hide" : "Watch") { drawer.toggle() }
                Button {
                    viewerProxy.start()
                    NSWorkspace.shared.open(viewerURL)
                } label: {
                    Image(systemName: "arrow.up.forward.app")
                }
                .help("Open in Screen Sharing")
                Button("Clear", action: runner.clear).disabled(runner.isRunning || runner.log.isEmpty)
                Button("Quit") { NSApp.terminate(nil) }
            }
            .buttonStyle(.borderless)
            .font(.callout)
        }
        .padding(12)
        .frame(width: 560)
        .onAppear { focused = true }
        // The popup's view is kept between openings, so onAppear/onDisappear don't track it;
        // watch the window itself instead.
        .background(WindowVisibility { visible, window in
            if visible {
                focused = true
                ScreenDrawer.shared.popupShown(window)
            } else {
                ScreenDrawer.shared.popupHidden()
            }
        })
        .onChange(of: runner.isRunning) {
            if runner.isRunning { ScreenDrawer.shared.taskStarted() }
        }
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
    @StateObject private var runner = AgentRunner()

    init() {
        viewerProxy.start()
    }

    var body: some Scene {
        MenuBarExtra {
            PanelView().environmentObject(runner)
        } label: {
            Image(systemName: runner.isRunning ? "cursorarrow.motionlines" : "cursorarrow.rays")
        }
        .menuBarExtraStyle(.window)
    }
}

// scrolling list with latest upfront
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


//Part of log section with a title and scrollable list
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
