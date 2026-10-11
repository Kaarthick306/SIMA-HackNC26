import AppKit
import SwiftUI

/// The agent's live screen, shown in its own borderless window attached below the menu bar popup.
/// It slides down from the popup's bottom edge. The popup itself never resizes, so nothing jumps
/// or flickers. All state lives here rather than in SwiftUI view state, which the menu bar popup
/// doesn't keep reliably between openings.
final class ScreenDrawer: ObservableObject {
    static let shared = ScreenDrawer()

    @Published private(set) var isOpen = false
    @Published fileprivate var revealed = false
    let live = LiveScreen()

    //weak refers without owning it
    private weak var popup: NSWindow?
    private var resizeObserver: NSObjectProtocol?
    private var panel: NSPanel?
    private let gap: CGFloat = 6

    /// Remembered choice: open the drawer whenever the popup opens. Hide turns it off; Watch turns it on.
    private var wantsOpen: Bool {
        get { UserDefaults.standard.object(forKey: "liveScreenOn") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "liveScreenOn") }
    }

    func popupShown(_ window: NSWindow) {
        if popup !== window {
            // Keep the drawer attached under the popup when it grows or shrinks (e.g. the log opens).
            if let resizeObserver { NotificationCenter.default.removeObserver(resizeObserver) }
            resizeObserver = NotificationCenter.default.addObserver(
                forName: NSWindow.didResizeNotification, object: window, queue: .main
            ) { [weak self] _ in self?.followPopup() }
        }
        popup = window
        log.notice("popup shown (wantsOpen=\(self.wantsOpen, privacy: .public))")
        if wantsOpen { open() }
    }

    func popupHidden() {
        log.notice("popup hidden")
        close(animated: false)
    }

    func toggle() {
        log.notice("toggle (isOpen=\(self.isOpen, privacy: .public))")
        if isOpen {
            wantsOpen = false
            close(animated: true)
        } else {
            wantsOpen = true
            open()
        }
    }

    func taskStarted() {
        log.notice("task started")
        open()
    }

    private func open() {
        guard !isOpen else { return }
        guard let popup, popup.isVisible else {
            log.notice("open skipped: popup window not visible")
            return
        }
        isOpen = true
        live.start()

        let width = popup.frame.width
        let size = live.frame?.size ?? CGSize(width: 2940, height: 1912)
        let height = (width * size.height / max(size.width, 1)).rounded()
        let panel = self.panel ?? makePanel()
        self.panel = panel
        panel.setFrame(
            NSRect(x: popup.frame.minX, y: popup.frame.minY - gap - height, width: width, height: height),
            display: false)
        panel.level = popup.level
        if panel.parent == nil { popup.addChildWindow(panel, ordered: .above) }
        panel.orderFront(nil)

        revealed = false
        DispatchQueue.main.async {
            guard self.isOpen else { return }
            withAnimation(.easeOut(duration: 0.35)) { self.revealed = true }
        }
    }

    private func followPopup() {
        guard isOpen, let popup, let panel else { return }
        panel.setFrameOrigin(NSPoint(x: popup.frame.minX, y: popup.frame.minY - gap - panel.frame.height))
    }

    private func close(animated: Bool) {
        guard isOpen else { return }
        isOpen = false
        live.stop()
        let finish = { [weak self] in
            guard let self, !self.isOpen, let panel = self.panel else { return }
            panel.parent?.removeChildWindow(panel)
            panel.orderOut(nil)
        }
        if animated {
            withAnimation(.easeIn(duration: 0.25)) {
                revealed = false
            } completion: {
                finish()
            }
        } else {
            revealed = false
            finish()
        }
    }

    private func makePanel() -> NSPanel {
        let p = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: true)
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = false
        p.hidesOnDeactivate = false
        p.isReleasedWhenClosed = false
        p.contentView = NSHostingView(rootView: DrawerView(drawer: self, live: live))
        return p
    }
}

/// The screen image, offset upward while hidden so it slides down into view.
private struct DrawerView: View {
    @ObservedObject var drawer: ScreenDrawer
    @ObservedObject var live: LiveScreen

    var body: some View {
        GeometryReader { geo in
            ZStack {
                RoundedRectangle(cornerRadius: 10).fill(Color.black.opacity(0.9))
                if let frame = live.frame {
                    Image(nsImage: frame)
                        .resizable()
                        .interpolation(.high)
                        .aspectRatio(contentMode: .fit)
                } else {
                    Text(live.status).font(Aero.font(13)).foregroundStyle(Aero.aqua)
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 10))
            // A glossy sky-blue bezel around the screen.
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(
                LinearGradient(colors: [.white, Aero.sky, Aero.deep], startPoint: .top, endPoint: .bottom), lineWidth: 3))
            .frame(width: geo.size.width, height: geo.size.height)
            .offset(y: drawer.revealed ? 0 : -geo.size.height)
        }
        .clipped()
    }
}
