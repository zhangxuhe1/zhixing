import SwiftUI
import XCTest

@testable import Zhixing

/// 常驻渲染回归：守护整卡可渲染+固定宽,并断言品牌标资源存在(命名图片缺失时 SwiftUI 是
/// 静默空渲,不 crash,渲染断言本身抓不住)。PNG 落盘 /tmp 仅为人工目检便利,失败不拖垮断言;
/// 项目测试被 project.yml 与 ios-test.sh 钉死在模拟器上,模拟器共享宿主文件系统,/tmp 可写。
@MainActor
final class TripShareCardRenderSmokeTests: XCTestCase {
    func test_renderShareCardToPNG() throws {
        XCTAssertNotNil(UIImage(named: "BrandMark"), "品牌图形标资源缺失(或测试脱离了 TEST_HOST 宿主)")
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
        try? data.write(to: url)
        print("share card written: \(url.path), bytes=\(data.count)")
    }
}
