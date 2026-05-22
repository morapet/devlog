// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "DevlogTray",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "DevlogTray",
            path: "Sources/DevlogTray"
        )
    ]
)
