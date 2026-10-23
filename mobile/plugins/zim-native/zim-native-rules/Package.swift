// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "zim-native-rules",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [
        .library(name: "ZimNativeRules", targets: ["ZimNativeRules"])
    ],
    targets: [
        .target(name: "ZimNativeRules"),
        .testTarget(name: "ZimNativeRulesTests", dependencies: ["ZimNativeRules"])
    ]
)
