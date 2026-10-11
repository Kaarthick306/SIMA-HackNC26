import AppKit
import Foundation
import os

let log = Logger(subsystem: "local.mac-agent.bar", category: "live-screen")

/// Streams the agent's screen by running 'backend/dist/viewer.js', which writes PNG frames to
/// stdout, each prefixed with a 4-byte big-endian length. Closing its stdin tells it to exit.
final class LiveScreen: ObservableObject {
    @Published var frame: NSImage?
    @Published var status = "Connecting…"

    private var process: Process?
    private var stdin: Pipe?
    private var buffer = Data()

    func start() {
        guard process == nil else { return }
        log.notice("start stream")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/opt/homebrew/bin/node")
        p.arguments = [projectDir.appendingPathComponent("backend/dist/viewer.js").path]
        var env = ProcessInfo.processInfo.environment
        env["MAC_AGENT_MAX_WIDTH"] = "1120"
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
        errors.fileHandleForReading.readabilityHandler = { [weak self] h in
            let data = h.availableData
            guard !data.isEmpty, let s = String(data: data, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return }
            DispatchQueue.main.async { self?.status = s.replacingOccurrences(of: "viewer: ", with: "") }
        }
        p.terminationHandler = { [weak self] _ in
            output.fileHandleForReading.readabilityHandler = nil
            errors.fileHandleForReading.readabilityHandler = nil
            DispatchQueue.main.async {
                guard let self, self.process === p else { return }
                self.process = nil
                self.stdin = nil
            }
        }

        do {
            try p.run()
            process = p
            stdin = input
            status = "Connecting… "
        } catch {
            status = "Couldn't start the live view: \(error.localizedDescription)"
        }
    }

    func stop() {
        guard let p = process else { return }
        log.notice("stop stream")
        process = nil
        try? stdin?.fileHandleForWriting.close()
        stdin = nil
        if p.isRunning { p.terminate() }
    }

    private func consume(_ data: Data) {
        buffer.append(data)
        var latest: Data?
        while buffer.count >= 4 {
            let len = buffer.prefix(4).reduce(0) { ($0 << 8) | Int($1) }
            guard buffer.count >= 4 + len else { break }
            latest = buffer.subdata(in: buffer.startIndex + 4..<buffer.startIndex + 4 + len)
            buffer.removeSubrange(buffer.startIndex..<buffer.startIndex + 4 + len)
        }
        if let latest, let image = NSImage(data: latest) {
            frame = image
        }
    }
}
