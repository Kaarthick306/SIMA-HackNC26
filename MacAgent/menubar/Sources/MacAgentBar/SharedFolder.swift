import AppKit
import Darwin

/// /Users/Shared/agent-shared: a folder only the user and the agent account can use (set up with
/// ACLs that new items inherit). Documents handed to the agent from the menu bar are copied here.
enum SharedFolder {
    static let url = URL(fileURLWithPath: "/Users/Shared/agent-shared", isDirectory: true)

    enum Outcome {
        case added(String)
        case skipped(String, reason: String)
    }

    /// Copy each file in. Only the contents are copied, into a brand-new file, so it picks up the
    /// folder's "user and agent" access instead of the original file's permissions. Originals are untouched.
    static func add(_ urls: [URL]) -> [Outcome] {
        let fm = FileManager.default
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue else {
            return urls.map { .skipped($0.lastPathComponent, reason: "the shared folder \(url.path) doesn't exist") }
        }
        return urls.map { src in
            let name = src.lastPathComponent
            guard fm.fileExists(atPath: src.path, isDirectory: &isDir) else {
                return .skipped(name, reason: "file not found")
            }
            if isDir.boolValue { return .skipped(name, reason: "folders aren't supported yet") }
            let dst = freeName(for: name)
            guard copyfile(src.path, dst.path, nil, copyfile_flags_t(COPYFILE_DATA)) == 0 else {
                return .skipped(name, reason: String(cString: strerror(errno)))
            }
            return .added(dst.lastPathComponent)
        }
    }

    /// "report.pdf", or "report 2.pdf", "report 3.pdf"… if that name is taken, like Finder.
    private static func freeName(for name: String) -> URL {
        let fm = FileManager.default
        var candidate = url.appendingPathComponent(name)
        let base = (name as NSString).deletingPathExtension
        let ext = (name as NSString).pathExtension
        var n = 2
        while fm.fileExists(atPath: candidate.path) {
            candidate = url.appendingPathComponent(ext.isEmpty ? "\(base) \(n)" : "\(base) \(n).\(ext)")
            n += 1
        }
        return candidate
    }

    static func openInFinder() {
        NSWorkspace.shared.open(url)
    }

    /// The standard file picker, several files at once.
    static func pickFiles() -> [URL] {
        NSApp.activate(ignoringOtherApps: true)
        let panel = NSOpenPanel()
        panel.title = "Share documents with the agent"
        panel.prompt = "Add"
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        return panel.runModal() == .OK ? panel.urls : []
    }
}
