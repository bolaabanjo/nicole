// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "NicoleMacOS",
  platforms: [
    .macOS(.v14),
  ],
  products: [
    .executable(
      name: "NicoleMacOS",
      targets: ["NicoleMacOS"]
    ),
  ],
  targets: [
    .executableTarget(
      name: "NicoleMacOS",
      path: "Sources"
    ),
  ]
)
