import XCTest
@testable import Zhixing

/// 宫格封顶 +N 缩略行的契约（spec：2026-07-17-photo-thumb-row-design.md）：
/// 遮罩数字 = 没露脸的张数（第 4 格本身是第 4 张照片盖遮罩）；4 张以内不盖遮罩。
final class PhotoThumbRowTests: XCTestCase {
    private func source(_ relativePath: String) throws -> String {
        let testsDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let sourceURL = testsDirectory.deletingLastPathComponent()
            .appendingPathComponent("Zhixing/\(relativePath)")
        return try String(contentsOf: sourceURL, encoding: .utf8)
    }

    func testOverflowAtOrBelowCapShowsNoBadge() {
        XCTAssertNil(ZXPhotoThumbRow.overflow(total: 1))
        XCTAssertNil(ZXPhotoThumbRow.overflow(total: 4))
    }

    func testOverflowAboveCapCountsHiddenPhotos() {
        XCTAssertEqual(ZXPhotoThumbRow.overflow(total: 5), 1)
        XCTAssertEqual(ZXPhotoThumbRow.overflow(total: 12), 8)
    }

    /// 源码断言（InteractionDesignTests 惯例）：锁住 72×72 规格、无横滑、合并朗读。
    func testComponentKeepsTileSpecAndAccessibility() throws {
        let component = try source("Core/ZXPhotoThumbRow.swift")

        XCTAssertTrue(component.contains(".frame(width: 72, height: 72)"))
        XCTAssertTrue(component.contains(".clipShape(RoundedRectangle(cornerRadius: 8))"))
        XCTAssertFalse(component.contains("ScrollView"))
        XCTAssertTrue(component.contains(".accessibilityElement(children: .ignore)"))
        XCTAssertTrue(component.contains("照片，共 \\(photoIds.count) 张"))
        // 身份不变量回归锁：瓦片身份必须绑照片 id（详见组件内注释），不得回退按位置。
        XCTAssertTrue(component.contains("id: \\.element"))
        XCTAssertFalse(component.contains("id: \\.offset"))
    }

    /// 两个列表行都必须用共用缩略行，不得回退横滑条。
    func testListRowsUseThumbRowInsteadOfHorizontalStrip() throws {
        let me = try source("Me/MeScreen.swift")
        let stories = try source("Place/StoriesSection.swift")

        XCTAssertTrue(me.contains("ZXPhotoThumbRow(photoIds: footprint.photos.map(\\.id))"))
        XCTAssertTrue(stories.contains("ZXPhotoThumbRow(photoIds: story.photos.map(\\.id))"))
        XCTAssertFalse(me.contains("ScrollView(.horizontal"))
        XCTAssertFalse(stories.contains("ScrollView(.horizontal"))
    }
}
