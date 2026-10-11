import AppKit
import SwiftUI

/// The log, in its own borderless window attached to the LEFT of the menu bar popup.
/// Like ScreenDrawer, its state lives here rather than in SwiftUI view state.
final class LogDrawer: ObservableObject {
    static let shared = LogDrawer()

    @Published private(set) var isOpen = false
    @Published fileprivate var revealed = false

    private weak var popup: NSWindow?
    private weak var runner: AgentRunner?
    private var panel: NSPanel?
    private var resizeObserver: NSObjectProtocol?
    private let gap: CGFloat = 6
    private let width: CGFloat = 340
    private let minHeight: CGFloat = 320

    //Keeping log in the last chosen state for pensonal interaction
    private var wantsOpen: Bool {
        get { UserDefaults.standard.bool(forKey: "showLog") }
        set { UserDefaults.standard.set(newValue, forKey: "showLog") }
    }

    func popupShown(_ window: NSWindow, runner: AgentRunner) {
        self.runner = runner
        if popup !== window {
            if let resizeObserver { NotificationCenter.default.removeObserver(resizeObserver) }
            resizeObserver = NotificationCenter.default.addObserver(
                forName: NSWindow.didResizeNotification, object: window, queue: .main
            ) { [weak self] _ in self?.followPopup() }
        }
        popup = window
        if wantsOpen { open() }
    }

    func popupHidden() {
        close(animated: false)
    }

    func toggle() {
        if isOpen {
            wantsOpen = false
            close(animated: true)
        } else {
            wantsOpen = true
            open()
        }
    }

    // Top-aligned to left of popup
    private func frame(for popup: NSWindow) -> NSRect {
        let height = max(popup.frame.height, minHeight)
        return NSRect(x: popup.frame.minX - gap - width, y: popup.frame.maxY - height, width: width, height: height)
    }

    private func open() {
        guard !isOpen, let popup, popup.isVisible, let runner else { return }
        isOpen = true
        let panel = self.panel ?? makePanel(runner: runner)
        self.panel = panel
        panel.setFrame(frame(for: popup), display: false)
        panel.level = popup.level
        if panel.parent == nil { popup.addChildWindow(panel, ordered: .above) }
        panel.orderFront(nil)

        revealed = false
        DispatchQueue.main.async {
            guard self.isOpen else { return }
            withAnimation(.easeOut(duration: 0.3)) { self.revealed = true }
        }
    }

    private func followPopup() {
        guard isOpen, let popup, let panel else { return }
        panel.setFrame(frame(for: popup), display: true)
    }

    private func close(animated: Bool) {
        guard isOpen else { return }
        isOpen = false
        let finish = { [weak self] in
            guard let self, !self.isOpen, let panel = self.panel else { return }
            panel.parent?.removeChildWindow(panel)
            panel.orderOut(nil)
        }
        if animated {
            withAnimation(.easeIn(duration: 0.2)) {
                revealed = false
            } completion: {
                finish()
            }
        } else {
            revealed = false
            finish()
        }
    }

    private func makePanel(runner: AgentRunner) -> NSPanel {
        let p = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        p.hidesOnDeactivate = false
        p.isReleasedWhenClosed = false
        p.contentView = NSHostingView(rootView: LogDrawerView(drawer: self, runner: runner))
        return p
    }
}

//2 section log drawer with slide out functionality
private struct LogDrawerView: View {
    @ObservedObject var drawer: LogDrawer
    @ObservedObject var runner: AgentRunner

    var body: some View {
        GeometryReader { geo in
            // Each part gets half the height, minus padding, spacing and its title row.
            let listHeight = max(60, (geo.size.height - 30) / 2 - 38)
            VStack(alignment: .leading, spacing: 10) {
                LogPart(title: "Files shared", empty: "No files shared yet",
                        lines: runner.log.filter { $0.section == .files }, listHeight: listHeight)
                LogPart(title: "Agent actions", empty: "No actions yet",
                        lines: runner.log.filter { $0.section == .actions }, listHeight: listHeight)
            }
            .padding(10)
            .frame(width: geo.size.width, height: geo.size.height, alignment: .top)
            .aeroText()
            .background(AeroBackground(cornerRadius: 10))
            .offset(x: drawer.revealed ? 0 : geo.size.width)
        }
        .clipped()
    }
}
