import Foundation
import Network

final class ViewerProxy {
    static let port: UInt16 = 5901
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "viewer-proxy")

    func start() {
        guard listener == nil else { return }
        let params = NWParameters.tcp
        params.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: Self.port)!)
        // If the port is taken (e.g. an older proxy is still running), keep using that one.
        guard let l = try? NWListener(using: params) else { return }
        l.newConnectionHandler = { [weak self] client in self?.bridge(client) }
        l.stateUpdateHandler = { [weak self] state in
            if case .failed = state { self?.listener = nil }
        }
        l.start(queue: queue)
        listener = l
    }

    private func bridge(_ client: NWConnection) {
        let server = NWConnection(host: "127.0.0.1", port: 5900, using: .tcp)
        let closeBoth = {
            client.cancel()
            server.cancel()
        }
        client.start(queue: queue)
        server.start(queue: queue)
        pump(from: client, to: server, onClose: closeBoth)
        pump(from: server, to: client, onClose: closeBoth)
    }

    private func pump(from src: NWConnection, to dst: NWConnection, onClose: @escaping () -> Void) {
        src.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, isComplete, error in
            if let data, !data.isEmpty {
                dst.send(content: data, completion: .contentProcessed { sendError in
                    if sendError != nil { onClose() }
                })
            }
            if isComplete || error != nil {
                onClose()
            } else {
                self?.pump(from: src, to: dst, onClose: onClose)
            }
        }
    }
}
