import SwiftUI
import XCTest

@testable import Zhixing

/// 临时冒烟：把分享卡真渲成 PNG 落盘,供人工目检品牌落款(BrandMark)效果。
/// 模拟器无沙箱强制,直接写 /tmp 便于宿主机读取。
@MainActor
final class TripShareCardRenderSmokeTests: XCTestCase {
    func test_renderShareCardToPNG() throws {
        let photo = UIGraphicsImageRenderer(size: CGSize(width: 300, height: 300)).image { ctx in
            UIColor(red: 0.32, green: 0.45, blue: 0.4, alpha: 1).setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: 300, height: 300))
        }
        let card = TripShareCard(
            title: "皖南三日",
            dateRange: "2026.04.02 – 04.04",
            cityNames: ["黄山", "宏村", "西递"],
            excerpts: ["雨后的宏村像一幅洇开的水墨,南湖的倒影比真实的天空更清晰。"],
            photos: [photo, photo, photo],
            qr: nil)
        let renderer = ImageRenderer(content: card)
        renderer.scale = 2
        let image = try XCTUnwrap(renderer.uiImage, "分享卡渲染不应为空")
        XCTAssertEqual(image.size.width, TripShareCard.width, accuracy: 1)
        let data = try XCTUnwrap(image.pngData())
        let url = URL(fileURLWithPath: "/tmp/zhixing-sharecard-smoke.png")
        try data.write(to: url)
        print("share card written: \(url.path), bytes=\(data.count)")
    }
}
