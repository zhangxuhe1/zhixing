import CoreImage.CIFilterBuiltins
import UIKit

/// 二维码生成：纯函数，包一层 CoreImage 内置 `CIQRCodeGenerator`。空串直接判 nil——生成器对空
/// 输入仍会吐出一张"看起来像"二维码但扫不出内容的图，调用方不该展示这种误导性图片。
/// `side`：期望的输出边长（pt）；纠错级别用 M（约 15% 容错），在图片体积与抗遮挡/抗印刷噪点
/// 之间取常见折中。生成器原生输出的是按二维码模块数定像素的小图（如 25×25），必然等宽高——
/// 用同一缩放系数变换 x/y 两轴放大到 `side`，形状始终是正方形，不会因为浮点误差走样。
func qrImage(from string: String, side: CGFloat) -> UIImage? {
    guard !string.isEmpty, let data = string.data(using: .utf8) else { return nil }

    let filter = CIFilter.qrCodeGenerator()
    filter.message = data
    filter.correctionLevel = "M"

    guard let output = filter.outputImage, output.extent.width > 0 else { return nil }
    let scale = side / output.extent.width
    let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))

    // 每次调用现建 CIContext（不用全局缓存实例）：qrImage 每次分享装配只会被调用一次，
    // 犯不上为省这点创建开销去引入一个跨并发域共享的全局可变状态。
    let context = CIContext()
    guard let cgImage = context.createCGImage(scaled, from: scaled.extent) else { return nil }
    return UIImage(cgImage: cgImage)
}
