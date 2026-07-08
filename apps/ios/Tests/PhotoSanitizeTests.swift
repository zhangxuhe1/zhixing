import ImageIO
import UIKit
import UniformTypeIdentifiers
import XCTest
@testable import Zhixing

/// `preparedPhotoUploadData`（I10 评审修复）：撰写器路径（sanitized=false）必须重编码剥 EXIF——
/// PhotosPicker 的 loadTransferable 给的是原始文件字节，JPEG 原图带 GPS/拍摄时间，直传会把
/// 公开面明令禁止的 lat/lng/takenAt 同族数据原样送上服务端；相册导入路径（sanitized=true）的
/// 自产 JPEG（UIImage.jpegData 产出，EXIF-free by construction）直传，保住双压修复。
final class PhotoSanitizeTests: XCTestCase {
    /// 带 GPS + DateTimeOriginal EXIF 的 JPEG fixture：CGImageDestination 写入时注入元数据字典。
    private func jpegWithGPSFixture() throws -> Data {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8))
        let image = renderer.image { ctx in
            UIColor.red.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        }
        let cgImage = try XCTUnwrap(image.cgImage)
        let data = NSMutableData()
        let dest = try XCTUnwrap(CGImageDestinationCreateWithData(
            data as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil))
        let properties: [CFString: Any] = [
            kCGImagePropertyGPSDictionary: [
                kCGImagePropertyGPSLatitude: 39.9042, kCGImagePropertyGPSLatitudeRef: "N",
                kCGImagePropertyGPSLongitude: 116.4074, kCGImagePropertyGPSLongitudeRef: "E",
            ],
            kCGImagePropertyExifDictionary: [
                kCGImagePropertyExifDateTimeOriginal: "2024:05:01 10:00:00",
            ],
        ]
        CGImageDestinationAddImage(dest, cgImage, properties as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(dest))
        return data as Data
    }

    private func imageProperties(_ data: Data) throws -> [CFString: Any] {
        let source = try XCTUnwrap(CGImageSourceCreateWithData(data as CFData, nil))
        return try XCTUnwrap(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
    }

    /// fixture 自检：确认造出来的 JPEG 真带 GPS 与拍摄时间——否则后面的"剥离"断言就是空转。
    func testFixtureActuallyCarriesGPSAndDateTimeOriginal() throws {
        let fixture = try jpegWithGPSFixture()
        XCTAssertTrue(fixture.isJPEG)
        let props = try imageProperties(fixture)
        XCTAssertNotNil(props[kCGImagePropertyGPSDictionary])
        let exif = try XCTUnwrap(props[kCGImagePropertyExifDictionary] as? [CFString: Any])
        XCTAssertNotNil(exif[kCGImagePropertyExifDateTimeOriginal])
    }

    /// 撰写器语义：sanitized=false 的 JPEG 原图必须经过重编码，产物不得再含 GPS/拍摄时间。
    func testUnsanitizedJPEGIsReencodedWithGPSAndCaptureTimeStripped() throws {
        let fixture = try jpegWithGPSFixture()
        let output = try XCTUnwrap(preparedPhotoUploadData(fixture, sanitized: false))
        XCTAssertTrue(output.isJPEG)
        XCTAssertNotEqual(output, fixture) // 不允许原字节直通
        let props = try imageProperties(output)
        XCTAssertNil(props[kCGImagePropertyGPSDictionary])
        // 重编码可能保留像素尺寸等无害 Exif 项；隐私敏感的拍摄时间必须已剥离。
        if let exif = props[kCGImagePropertyExifDictionary] as? [CFString: Any] {
            XCTAssertNil(exif[kCGImagePropertyExifDateTimeOriginal])
        }
    }

    /// 相册导入语义：sanitized=true 且已是 JPEG → 字节原样直通（信任契约由调用方兑现：
    /// 导入路径的输入是我们自己 UIImage.jpegData 重编码产出的，构造上就不含 EXIF）。
    func testSanitizedJPEGPassesThroughByteIdentical() throws {
        let fixture = try jpegWithGPSFixture()
        XCTAssertEqual(preparedPhotoUploadData(fixture, sanitized: true), fixture)
    }

    /// sanitized=true 但不是 JPEG（防御路径）：仍走转码，产物是 JPEG。
    func testSanitizedNonJPEGStillTranscodesToJPEG() throws {
        let png = try XCTUnwrap(
            UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).image { ctx in
                UIColor.blue.setFill()
                ctx.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
            }.pngData())
        XCTAssertFalse(png.isJPEG)
        let output = try XCTUnwrap(preparedPhotoUploadData(png, sanitized: true))
        XCTAssertTrue(output.isJPEG)
    }
}
