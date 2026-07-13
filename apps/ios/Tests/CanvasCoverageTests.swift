import CoreImage
import SwiftUI
import XCTest
@testable import Zhixing

/// 页面根背景覆盖回归测试：调用点源码护栏 + 宽屏离屏渲染像素断言。
///
/// 空状态、加载态与完成态通常按内容收缩；直接挂 `.background(ZXTheme.canvas)` 只会给中间内容块
/// 着色，在 iPad / Mac Catalyst 宽屏上露出上下两段系统白底。以下会切换到收缩态的页面必须使用
/// `zxCanvasBackground()`，由主题层统一负责撑满导航内容区并越过安全区。
final class CanvasCoverageTests: XCTestCase {
    private let fullCanvasScreens = [
        "AlbumImportScreen.swift",
        "FavoritesScreen.swift",
        "ReportSheet.swift",
        "SearchSheet.swift",
        "TripsScreen.swift",
    ]

    private func sourceFile(named filename: String) throws -> URL {
        let testsDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let sourcesDirectory = testsDirectory.deletingLastPathComponent().appendingPathComponent("Zhixing")
        let enumerator = FileManager.default.enumerator(
            at: sourcesDirectory,
            includingPropertiesForKeys: nil)
        while let url = enumerator?.nextObject() as? URL {
            if url.lastPathComponent == filename { return url }
        }
        throw CocoaError(.fileNoSuchFile)
    }

    func testShrinkableScreenRootsUseFullCanvasBackground() throws {
        for filename in fullCanvasScreens {
            let url = try sourceFile(named: filename)
            let source = try String(contentsOf: url, encoding: .utf8)
            XCTAssertTrue(
                source.contains(".zxCanvasBackground()"),
                "\(filename) 的根内容可能按状态收缩，必须使用 zxCanvasBackground() 铺满背景")
        }
    }

    /// 真实渲染一个按内容收缩的空状态，并检查四角都落在宣纸底色上；旧的局部 `.background`
    /// 实现会在这里得到透明/系统白像素，因此比只扫描修饰器源码更接近截图里的实际回归。
    @MainActor
    func testCanvasModifierRendersAcrossWideViewport() throws {
        let view = ZXEmptyState(icon: "bookmark", title: "空状态", message: "测试")
            .zxCanvasBackground()
            .environment(\.colorScheme, .light)
        let renderer = ImageRenderer(content: view)
        renderer.proposedSize = ProposedViewSize(width: 900, height: 700)
        renderer.scale = 1

        let image = try XCTUnwrap(renderer.uiImage)
        XCTAssertEqual(image.size.width, 900, accuracy: 0.5)
        XCTAssertEqual(image.size.height, 700, accuracy: 0.5)

        let expected = rgbaBytes(for: UIColor(ZXTheme.canvas).resolvedColor(
            with: UITraitCollection(userInterfaceStyle: .light)))
        for point in [CGPoint(x: 2, y: 2), CGPoint(x: 897, y: 2),
                      CGPoint(x: 2, y: 697), CGPoint(x: 897, y: 697)] {
            let actual = try rgbaBytes(in: image, at: point)
            for channel in 0 ..< 4 {
                XCTAssertEqual(
                    actual[channel], expected[channel], accuracy: 2,
                    "视口边缘 \(point) 未被 ZXTheme.canvas 完整覆盖")
            }
        }
    }

    private func rgbaBytes(for color: UIColor) -> [UInt8] {
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        color.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        return [red, green, blue, alpha].map { UInt8(($0 * 255).rounded()) }
    }

    private func rgbaBytes(in image: UIImage, at point: CGPoint) throws -> [UInt8] {
        let ciImage = try XCTUnwrap(CIImage(image: image))
        var bytes = [UInt8](repeating: 0, count: 4)
        CIContext(options: [.workingColorSpace: NSNull()]).render(
            ciImage,
            toBitmap: &bytes,
            rowBytes: 4,
            bounds: CGRect(origin: point, size: CGSize(width: 1, height: 1)),
            format: .RGBA8,
            colorSpace: CGColorSpaceCreateDeviceRGB())
        return bytes
    }
}
