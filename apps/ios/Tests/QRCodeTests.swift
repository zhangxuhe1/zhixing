import CoreImage
import XCTest
@testable import Zhixing

/// `qrImage` 契约：CoreImage `CIQRCodeGenerator` 的纯函数包装。合法非空字符串编码出非 nil 且
/// 方形的图片（二维码矩阵天然等宽高，缩放时按同一系数变换两轴，形状不会走样）；空串直接判 nil——
/// 生成器对空输入仍会吐出一张"看起来像"二维码但扫不出内容的图，调用方不该展示这种误导性图片。
final class QRCodeTests: XCTestCase {
    func testValidStringProducesSquareNonNilImage() throws {
        let image = try XCTUnwrap(qrImage(from: "https://zhixing.example.com/beta", side: 200))

        XCTAssertEqual(image.size.width, image.size.height, accuracy: 0.5, "二维码必须是正方形")
        XCTAssertEqual(image.size.width, 200, accuracy: 1.0, "输出边长应贴近请求的 side")
    }

    func testEmptyStringProducesNil() {
        XCTAssertNil(qrImage(from: "", side: 200))
    }

    /// "看起来像二维码"不等于"扫得出来"：用系统自带的 `CIDetector` QR 检测器把生成的图片解码
    /// 回原始字符串，替代人工用相机扫一次的手动核验——这条断言真正覆盖"可被相机识别"，而不只是
    /// 形状/尺寸这类外观检查。模拟器没有摄像头，但解码一张静态图片不需要摄像头，只需要视觉算法。
    func testValidStringRoundTripsThroughCIDetector() throws {
        let payload = "https://zhixing.example.com/beta"
        let image = try XCTUnwrap(qrImage(from: payload, side: 240))
        let ciImage = try XCTUnwrap(CIImage(image: image))
        let detector = try XCTUnwrap(CIDetector(
            ofType: CIDetectorTypeQRCode, context: nil,
            options: [CIDetectorAccuracy: CIDetectorAccuracyHigh]))

        let features = detector.features(in: ciImage).compactMap { $0 as? CIQRCodeFeature }

        XCTAssertEqual(features.first?.messageString, payload, "生成的二维码必须能被标准 QR 检测器解出原始内容")
    }
}
