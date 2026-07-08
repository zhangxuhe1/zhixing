import XCTest
@testable import Zhixing

/// `Data.isJPEG`：仅看 FF D8 魔数前缀，供 `preparedPhotoUploadData` 判断"已脱敏且已是 JPEG 就不
/// 重编码"（item 2；直通仅限 sanitized 来源——EXIF 剥离语义见 PhotoSanitizeTests）。
final class JPEGDetectTests: XCTestCase {
    func testJPEGMagicBytesDetected() {
        XCTAssertTrue(Data([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]).isJPEG)
    }

    func testPNGBytesAreNotJPEG() {
        XCTAssertFalse(Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).isJPEG)
    }

    func testEmptyDataIsNotJPEG() {
        XCTAssertFalse(Data().isJPEG)
    }
}
