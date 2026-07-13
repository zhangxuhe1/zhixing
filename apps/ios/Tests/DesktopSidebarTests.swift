import XCTest

/// Catalyst 侧栏操作层级源码护栏。
///
/// ZhixingTests 只编译 iOS 模拟器目标，`targetEnvironment(macCatalyst)` 分支不会进入测试产物；
/// 用源码断言确保高频相册导入位于侧栏内容区、低频退出操作独立沉底，
/// 同时不从 iPhone 的「我的」页移除。
final class DesktopSidebarTests: XCTestCase {
    private func appSource(named filename: String) throws -> String {
        let testsDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let sourceURL = testsDirectory.deletingLastPathComponent()
            .appendingPathComponent("Zhixing")
            .appendingPathComponent(filename)
        return try String(contentsOf: sourceURL, encoding: .utf8)
    }

    func testDesktopSidebarSeparatesImportFromBottomAccountAction() throws {
        let source = try appSource(named: "App/RootView.swift")
        let bottomInset = try XCTUnwrap(source.range(of: ".safeAreaInset(edge: .bottom)"))
        let sidebarContent = String(source[..<bottomInset.lowerBound])

        XCTAssertTrue(source.contains(".safeAreaInset(edge: .bottom)"))
        XCTAssertTrue(source.contains("private var sidebarAccountAction: some View"))
        XCTAssertTrue(sidebarContent.contains("Text(\"快捷操作\")"))
        XCTAssertTrue(sidebarContent.contains("Text(\"从相册点亮旅行\")"))
        XCTAssertTrue(sidebarContent.contains("Label(\"导入的足迹默认仅自己可见\", systemImage: \"lock.fill\")"))
        XCTAssertTrue(source.contains("Button(role: .destructive) { session.signOut() }"))
        XCTAssertTrue(source.contains("AlbumImportScreen().appStores()"))
    }

    func testPhoneMeScreenRetainsActionsOutsideCatalyst() throws {
        let source = try appSource(named: "Me/MeScreen.swift")

        XCTAssertTrue(source.contains("#if !targetEnvironment(macCatalyst)"))
        XCTAssertTrue(source.contains("Label(\"从相册点亮过去的旅行\", systemImage: \"photo.stack.fill\")"))
        XCTAssertTrue(source.contains("Button(role: .destructive) { session.signOut() }"))
    }
}
