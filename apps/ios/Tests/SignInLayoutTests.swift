import XCTest

/// 登录页全出血背景的源码护栏。
///
/// Catalyst 窗口物理尺寸可能大于安全区可用区；背景必须能独立越过安全区铺满整个窗口，
/// 否则边缘（尤其底部）会露出默认白色底色。历史上踩过两个坑：
///   1. 把底图钉死为 GeometryReader 尺寸再 clipped，后续 ignoresSafeArea 无法延伸到窗口边缘；
///   2. 把 `.scaledToFill()` 的 Image 直接当作 ZStack 兄弟层，aspect-fill 溢出会把整个背景
///      （连同兜底色）撑成图片自身的宽高比——当窗口比图片更“高”时背景比窗口矮一截，底部露白，
///      且只在“某些窗口尺寸”下复现。
/// 正确姿势：以 `ZXTheme.rice`（Color，永远精确铺满被提议尺寸）作尺寸锚点，底图/蒙版一律走
/// `.overlay`（不反向撑大宿主）+ `.clipped()` + `.ignoresSafeArea()`。
final class SignInLayoutTests: XCTestCase {
    private func source() throws -> String {
        let testsDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let sourceURL = testsDirectory.deletingLastPathComponent()
            .appendingPathComponent("Zhixing/Auth/SignInScreen.swift")
        return try String(contentsOf: sourceURL, encoding: .utf8)
    }

    private func fullBleedBackgroundSource() throws -> String {
        let source = try source()
        let start = try XCTUnwrap(source.range(of: "private var fullBleedBackground"))
        let end = try XCTUnwrap(
            source.range(of: "private var landscapeLayout", range: start.upperBound ..< source.endIndex))
        return String(source[start.lowerBound ..< end.lowerBound])
    }

    func testFullBleedBackgroundCoversWindowViaClippedIgnoresSafeArea() throws {
        let background = try fullBleedBackgroundSource()

        XCTAssertTrue(background.contains("Image(\"LoginLandscape\")"))
        XCTAssertTrue(background.contains(".scaledToFill()"))
        XCTAssertTrue(background.contains(".clipped()"))
        XCTAssertTrue(background.contains(".ignoresSafeArea()"))

        // 旧回归 1：不得把底图钉死在 GeometryReader 尺寸
        XCTAssertFalse(background.contains(".frame(width: proxy.size.width"))
    }

    func testFullBleedBackgroundIsColorAnchoredWithImageAsOverlay() throws {
        let background = try fullBleedBackgroundSource()

        // 尺寸锚点是 Color(ZXTheme.rice)，底图必须作为它之后的 .overlay 出现
        let rice = try XCTUnwrap(background.range(of: "ZXTheme.rice"))
        let overlay = try XCTUnwrap(background.range(of: ".overlay {"))
        let image = try XCTUnwrap(background.range(of: "Image(\"LoginLandscape\")"))
        XCTAssertTrue(rice.lowerBound < overlay.lowerBound,
                      "背景必须以 ZXTheme.rice 作为尺寸锚点起始")
        XCTAssertTrue(overlay.lowerBound < image.lowerBound,
                      "底图必须作为 .overlay 挂载，避免 aspect-fill 溢出撑大背景")

        // 旧回归 2：不得把 scaledToFill 的 Image 当作 ZStack 兄弟层（会按图片宽高比撑大背景 → 露白）
        XCTAssertFalse(background.contains("ZStack"),
                       "背景改用 Color+overlay 锚定尺寸；重新引入 ZStack 兄弟层会回归露白 bug")
    }

    func testBackgroundDoesNotParticipateInContentLayout() throws {
        let source = try source()
        let backgroundStart = try XCTUnwrap(source.range(of: "private var fullBleedBackground"))
        let body = String(source[..<backgroundStart.lowerBound])

        XCTAssertTrue(body.contains(".background {\n            fullBleedBackground\n        }"))
        XCTAssertFalse(body.contains("ZStack {\n                fullBleedBackground"))
    }
}
