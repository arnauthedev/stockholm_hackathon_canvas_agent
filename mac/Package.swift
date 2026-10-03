// swift-tools-version:5.9
// The Mac notch shell. Builds with the Command Line Tools alone (no Xcode): `bash mac/build.sh`.
import PackageDescription

let package = Package(
  name: "CanvasAgentMac",
  platforms: [.macOS(.v14)],
  targets: [
    .executableTarget(name: "CanvasAgent", path: "Sources/CanvasAgent"),
  ]
)
