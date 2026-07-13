import XCTest

/// 登录页全出血背景的源码护栏。
///
/// Catalyst 窗口的可用内容区可能带底部安全区；若背景先固定为 GeometryReader 的尺寸再裁剪，
/// 后续的 ignoresSafeArea 无法把图片延伸到窗口底部，会露出默认白色底色。
final class SignInLayoutTests: XCTestCase {
    private func source() throws -> String {
        let testsDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let sourceURL = testsDirectory.deletingLastPathComponent()
            .appendingPathComponent("Zhixing/Auth/SignInScreen.swift")
        return try String(contentsOf: sourceURL, encoding: .utf8)
    }

    func testBackgroundIgnoresSafeAreaWithoutFixedGeometryFrame() throws {
        let source = try source()
        let backgroundStart = try XCTUnwrap(source.range(of: "private var fullBleedBackground"))
        let backgroundEnd = try XCTUnwrap(
            source.range(of: "private var landscapeLayout", range: backgroundStart.upperBound ..< source.endIndex))
        let background = String(source[backgroundStart.lowerBound ..< backgroundEnd.lowerBound])

        XCTAssertTrue(background.contains("Image(\"LoginLandscape\")"))
        XCTAssertTrue(background.contains(".scaledToFill()"))
        XCTAssertTrue(background.contains(".ignoresSafeArea()"))
        XCTAssertFalse(background.contains(".frame(width: proxy.size.width"))
        XCTAssertFalse(background.contains(".clipped()"))
    }

    func testBackgroundDoesNotParticipateInContentLayout() throws {
        let source = try source()
        let backgroundStart = try XCTUnwrap(source.range(of: "private var fullBleedBackground"))
        let body = String(source[..<backgroundStart.lowerBound])

        XCTAssertTrue(body.contains(".background {\n            fullBleedBackground\n        }"))
        XCTAssertFalse(body.contains("ZStack {\n                fullBleedBackground"))
    }
}
