// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MacAgentBar",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(name: "MacAgentBar", path: "Sources/MacAgentBar")
    ]
)