import XCTest
@testable import Zhixing

/// 全局照片内存缓存(spec:2026-07-17-photo-memory-cache-design.md):
/// photoId → 降采样位图,一处下载全 App 复用;photoId 内容不可变(API 无改写端点),
/// 按 id 缓存无需失效钩子。
final class PhotoMemoryCacheTests: XCTestCase {
    override func setUp() {
        super.setUp()
        ZXPhotoMemoryCache.shared.removeAll()
    }

    private static let tinyImage: UIImage = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4))
        .image { ctx in
            UIColor.red.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
        }

    func testInsertThenLookupRoundTrip() {
        XCTAssertNil(ZXPhotoMemoryCache.shared.image(for: "p1"))
        ZXPhotoMemoryCache.shared.insert(Self.tinyImage, for: "p1")
        XCTAssertNotNil(ZXPhotoMemoryCache.shared.image(for: "p1"))
        XCTAssertNil(ZXPhotoMemoryCache.shared.image(for: "p2"))
    }

    func testRemoveAllEvictsEverything() {
        ZXPhotoMemoryCache.shared.insert(Self.tinyImage, for: "p1")
        ZXPhotoMemoryCache.shared.removeAll()
        XCTAssertNil(ZXPhotoMemoryCache.shared.image(for: "p1"))
    }

    /// 契约:宫格照片视图必须"先查缓存、降采样解码、写回缓存"——
    /// UIImage(data:) 全分辨率解码(24MP≈90MB/张、无上界)不得回潮。
    func testAuthedPhotoViewUsesCacheAndDownsampling() throws {
        let testsDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let source = try String(
            contentsOf: testsDirectory.deletingLastPathComponent()
                .appendingPathComponent("Zhixing/Footprint/AuthedPhotoView.swift"),
            encoding: .utf8)

        XCTAssertTrue(source.contains("ZXPhotoMemoryCache"))
        XCTAssertTrue(source.contains("downsampledImage"))
        XCTAssertFalse(source.contains("UIImage(data: data)"))
    }
}
