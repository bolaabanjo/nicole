// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "Nicole",
  platforms: [
    .macOS(.v14),
  ],
  dependencies: [
    .package(url: "https://github.com/gonzalezreal/swift-markdown-ui", from: "2.4.0"),
  ],
  targets: [
    .executableTarget(
      name: "NicoleMacOS",
      dependencies: [
        .product(name: "MarkdownUI", package: "swift-markdown-ui"),
      ],
      path: "Sources"
    ),
  ]
)
