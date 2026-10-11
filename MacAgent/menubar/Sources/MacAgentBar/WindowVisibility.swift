import AppKit
import SwiftUI

/// Reports whether the window hosting this view is on screen. Used for the menu bar popup, whose
/// SwiftUI view stays alive while the popup is closed.
struct WindowVisibility: NSViewRepresentable {
    let onChange: (Bool, NSWindow) -> Void

    func makeNSView(context: Context) -> VisibilityView {
        let view = VisibilityView()
        view.onChange = onChange
        return view
    }

    func updateNSView(_ view: VisibilityView, context: Context) {
        view.onChange = onChange
    }
}

final class VisibilityView: NSView {
    var onChange: ((Bool, NSWindow) -> Void)?
    private var observers: [NSObjectProtocol] = []
    private var lastReported: Bool?

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        guard let window else { return }
        observers = [NSWindow.didChangeOcclusionStateNotification, NSWindow.didBecomeKeyNotification].map {
            NotificationCenter.default.addObserver(forName: $0, object: window, queue: .main) { [weak self] _ in
                self?.report()
            }
        }
        DispatchQueue.main.async { [weak self] in self?.report() }
    }

    private func report() {
        guard let window else { return }
        let visible = window.isVisible
        guard visible != lastReported else { return }
        lastReported = visible
        onChange?(visible, window)
    }

    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
    }
}
