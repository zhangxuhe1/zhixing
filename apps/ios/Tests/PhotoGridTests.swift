import XCTest
@testable import Zhixing

/// 详情页照片自适应宫格的契约（spec：2026-07-17-photo-grid-design.md）：
/// 1 张=整宽 4:3 题图、2 张=两格对分、≥3 张=三列宫格；两个详情页共用组件，
/// 整宽横幅（minHeight: 220 + scaledToFill 裁切）不复存在。
final class PhotoGridTests: XCTestCase {
    private func source(_ relativePath: String) throws -> String {
        let testsDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let sourceURL = testsDirectory.deletingLastPathComponent()
            .appendingPathComponent("Zhixing/\(relativePath)")
        return try String(contentsOf: sourceURL, encoding: .utf8)
    }

    func testLayoutTiers() {
        XCTAssertEqual(ZXPhotoGrid.layout(for: 1), .single)
        XCTAssertEqual(ZXPhotoGrid.layout(for: 2), .pair)
        XCTAssertEqual(ZXPhotoGrid.layout(for: 3), .grid)
        XCTAssertEqual(ZXPhotoGrid.layout(for: 4), .grid)
        XCTAssertEqual(ZXPhotoGrid.layout(for: 12), .grid)
    }

    /// 源码断言（InteractionDesignTests 惯例）：定框裁切必须用 Color.clear 写法、
    /// 格子身份绑照片 id、组件不含业务文案。
    func testComponentKeepsClippingAndIdentityGuardrails() throws {
        let component = try source("Core/ZXPhotoGrid.swift")

        XCTAssertTrue(component.contains("Color.clear"))
        XCTAssertTrue(component.contains(".aspectRatio("))
        XCTAssertTrue(component.contains("id: \\.element"))
        XCTAssertFalse(component.contains("id: \\.offset"))
        XCTAssertFalse(component.contains("足迹"))
        XCTAssertFalse(component.contains("故事"))
    }

    /// 足迹详情必须用共用宫格，整宽横幅写法（minHeight: 220）不得回潮。
    func testFootprintDetailUsesGridInsteadOfBanner() throws {
        let detail = try source("Footprint/FootprintDetailView.swift")

        XCTAssertTrue(detail.contains("ZXPhotoGrid(photoIds: current.photos.map(\\.id))"))
        XCTAssertFalse(detail.contains("minHeight: 220"))
    }
}
