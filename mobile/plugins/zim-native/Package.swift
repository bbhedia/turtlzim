// swift-tools-version: 5.9
import PackageDescription

// The plugin of the iPhone app that Android's ZimNativePlugin is the other half of. The rules (what may be asked of the network, fingerprints) are a package of their own, with nothing of the
// phone in it, so that CI tries them on a Mac without a simulator (`swift test` in zim-native-rules).
let package = Package(
    name: "ZimNative",
    platforms: [.iOS(.v15)],
    products: [
        .library(name: "ZimNative", targets: ["ZimNativePlugin"])
    ],
    dependencies: [
        .package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0"),
        .package(path: "zim-native-rules")
    ],
    targets: [
        .target(
            name: "ZimNativePlugin",
            dependencies: [
                .product(name: "Capacitor", package: "capacitor-swift-pm"),
                .product(name: "Cordova", package: "capacitor-swift-pm"),
                .product(name: "ZimNativeRules", package: "zim-native-rules")
            ],
            path: "ios/Sources/ZimNativePlugin")
    ]
)
