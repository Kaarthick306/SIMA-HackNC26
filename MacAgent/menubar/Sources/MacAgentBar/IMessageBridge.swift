import AppKit
import Foundation
import Security
import os


final class IMessageBridge: ObservableObject {
    static let shared = IMessageBridge()

    @Published private(set) var enabled = UserDefaults.standard.bool(forKey: "imessageEnabled")
    @Published private(set) var status = "Off" {
        didSet { if status != oldValue { log.notice("imessage status: \(self.status, privacy: .public)") } }
    }

    private(set) var handle = UserDefaults.standard.string(forKey: "imessageHandle") ?? ""
    private(set) var projectId = UserDefaults.standard.string(forKey: "spectrumProjectId") ?? ""
    private static let keychainService = "mac-agent-spectrum"

    private weak var runner: AgentRunner?
    private var process: Process?
    private var stdin: Pipe?
    private var buffer = Data()
    // to set when a text asked to stop the task
    private var stoppedByText = false
    private static let restartDelay: TimeInterval = 15

    //start listening once launched
    func attach(_ runner: AgentRunner) {
        self.runner = runner
        if enabled { start() }
    }

    //Turning panel button on asks for your number and Photon project the first time. To focus on interactiveness
    func toggle(askSetup: Bool = false) {
        if enabled && !askSetup {
            setEnabled(false)
            stop()
            status = "Off"
            return
        }
        if handle.isEmpty || projectId.isEmpty || askSetup {
            guard let entered = promptForSetup() else { return }
            if !entered.secret.isEmpty, !Self.saveSecret(entered.secret, project: entered.projectId) {
                status = "Can't save the project secret to the Keychain"
                return
            }
            handle = entered.handle
            projectId = entered.projectId
            UserDefaults.standard.set(handle, forKey: "imessageHandle")
            UserDefaults.standard.set(projectId, forKey: "spectrumProjectId")
        }
        setEnabled(true)
        stop()
        start()
    }

    private func setEnabled(_ on: Bool) {
        enabled = on
        UserDefaults.standard.set(on, forKey: "imessageEnabled")
    }

    private func promptForSetup() -> (handle: String, projectId: String, secret: String)? {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Text tasks to the agent"
        alert.informativeText = "The agent gets its own iMessage number from Photon. "
            + "Enter your own number, the project ID and secret from the "
            + "Photon dashboard. The secret is kept in your Keychain."
        func field(_ placeholder: String, _ value: String, secure: Bool = false) -> NSTextField {
            let f = secure ? NSSecureTextField() : NSTextField()
            f.placeholderString = placeholder
            f.stringValue = value
            f.widthAnchor.constraint(equalToConstant: 300).isActive = true
            return f
        }
        let mine = field("Your number: +0 000 123 6767 or sima@example.com", handle)
        let project = field("Photon project ID", projectId)
        let secret = field(projectId.isEmpty ? "Photon project secret" : "Project secret (leave empty to keep)", "", secure: true)
        let stack = NSStackView(views: [mine, project, secret])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.frame = NSRect(x: 0, y: 0, width: 300, height: 88)
        alert.accessoryView = stack
        alert.window.initialFirstResponder = mine
        mine.nextKeyView = project
        project.nextKeyView = secret
        alert.addButton(withTitle: "Turn On")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return nil }
        func trimmed(_ f: NSTextField) -> String { f.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) }
        let entered = (handle: trimmed(mine), projectId: trimmed(project), secret: trimmed(secret))
        // A secret is needed unless one is already saved for this project.
        let hasSecret = !entered.secret.isEmpty || (entered.projectId == projectId && Self.loadSecret(project: projectId) != nil)
        return entered.handle.isEmpty || entered.projectId.isEmpty || !hasSecret ? nil : entered
    }

    private static func saveSecret(_ secret: String, project: String) -> Bool {
        let item: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: keychainService, kSecAttrAccount: project]
        SecItemDelete(item as CFDictionary)
        return SecItemAdd(item.merging([kSecValueData: Data(secret.utf8)]) { $1 } as CFDictionary, nil) == errSecSuccess
    }

    private static func loadSecret(project: String) -> String? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword, kSecAttrService: keychainService, kSecAttrAccount: project,
            kSecReturnData: true, kSecMatchLimit: kSecMatchLimitOne,
        ]
        var out: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    private func start() {
        guard process == nil, enabled, !handle.isEmpty, !projectId.isEmpty else { return }
        guard let secret = Self.loadSecret(project: projectId) else {
            status = "No project secret in the Keychain. ⌥-click to enter it again."
            return
        }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/opt/homebrew/bin/node")
        p.arguments = [projectDir.appendingPathComponent("backend/dist/imessages.js").path]
        var env = ProcessInfo.processInfo.environment
        env["MAC_AGENT_IMESSAGE_HANDLE"] = handle
        env["SPECTRUM_PROJECT_ID"] = projectId
        env["SPECTRUM_PROJECT_SECRET"] = secret
        p.environment = env

        let input = Pipe(), output = Pipe(), errors = Pipe()
        p.standardInput = input
        p.standardOutput = output
        p.standardError = errors

        buffer = Data()
        output.fileHandleForReading.readabilityHandler = { [weak self] h in
            let data = h.availableData
            guard !data.isEmpty else { return }
            DispatchQueue.main.async { self?.consume(data) }
        }
        log.notice("imessage: starting the bridge")
        errors.fileHandleForReading.readabilityHandler = { h in
            let data = h.availableData
            guard !data.isEmpty, let s = String(data: data, encoding: .utf8) else { return }
            log.notice("imessage: \(s, privacy: .public)")
        }
        p.terminationHandler = { [weak self] _ in
            output.fileHandleForReading.readabilityHandler = nil
            errors.fileHandleForReading.readabilityHandler = nil
            DispatchQueue.main.async {
                guard let self, self.process === p else { return }
                self.process = nil
                self.stdin = nil
                // It only exits by itself when something is wrong; keep that message and try again later.
                if self.status.hasPrefix("Listening") || self.status == "Starting…" { self.status = "Stopped unexpectedly; retrying" }
                DispatchQueue.main.asyncAfter(deadline: .now() + Self.restartDelay) { self.start() }
            }
        }

        do {
            try p.run()
            process = p
            stdin = input
            status = "Starting…"
        } catch {
            status = "Couldn't start: \(error.localizedDescription)"
        }
    }

    private func stop() {
        guard let p = process else { return }
        process = nil
        try? stdin?.fileHandleForWriting.close()
        stdin = nil
        if p.isRunning { p.terminate() }
    }

    private func consume(_ data: Data) {
        buffer.append(data)
        while let nl = buffer.firstIndex(of: 0x0A) {
            let line = buffer.subdata(in: buffer.startIndex..<nl)
            buffer.removeSubrange(buffer.startIndex...nl)
            guard let obj = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
            switch obj["type"] as? String {
            case "ready": status = "Listening for texts from \(handle)"
            case "error": status = obj["message"] as? String ?? "Error"
            case "task": if let text = obj["text"] as? String { received(text) }
            default: break
            }
        }
    }

    private func received(_ text: String) {
        log.notice("imessage: a task arrived by text (\(text.count) characters)")
        guard let runner else { return }
        switch text.lowercased() {
        case "stop", "cancel":
            guard runner.isRunning else { return reply("Nothing is running.") }
            stoppedByText = true
            runner.stop()
            reply("Stopped.", screenshot: true)
        case "status":
            reply(runner.isRunning ? "Working on a task. Text 'stop' to cancel it." : "Idle. Text me a task.")
        default:
            guard !runner.isRunning else { return reply("Busy with another task. Text 'stop' to cancel it.") }
            stoppedByText = false
            reply("On it.")
            runner.run(text, fromText: true) { [weak self] answer, ran in
                guard let self else { return }
                if self.stoppedByText { return self.stoppedByText = false }
                self.reply(answer, screenshot: ran)
            }
        }
    }

    private func reply(_ text: String, screenshot: Bool = false) {
        guard let stdin, let data = try? JSONSerialization.data(withJSONObject: ["type": "reply", "text": text, "screenshot": screenshot])
        else { return }
        log.notice("imessage: replying (\(text.count) characters, screenshot \(screenshot))")
        try? stdin.fileHandleForWriting.write(contentsOf: data + Data([0x0A]))
    }
}
