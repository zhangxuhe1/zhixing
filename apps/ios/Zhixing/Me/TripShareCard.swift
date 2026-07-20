import SwiftUI

/// 分享长图模板：固定宽 390pt、纵向自适应高度——交给 `ImageRenderer` 按内容定高，本视图只管
/// 排布，不关心最终会被渲成多高。
///
/// 强制浅色配色（`.environment(\.colorScheme, .light)`）：`ImageRenderer` 脱离正常的系统外观树
/// 离屏渲染，不走 `UITraitCollection` 的传播路径，`.preferredColorScheme` 在这种场景不可靠——
/// 直接覆盖 colorScheme 环境值，让 `.secondary`/`.tertiary`/`Divider()` 等语义色和系统控件在
/// 深色模式设备上也解析成浅色配色（规格："深浅色下均可读，固定浅色底即可"）。
struct TripShareCard: View {
    static let width: CGFloat = 390
    private static let horizontalPadding: CGFloat = 24
    private static let gridSpacing: CGFloat = 4

    let title: String
    let dateRange: String
    let cityNames: [String]
    let excerpts: [String]
    let photos: [UIImage]
    let qr: UIImage?

    /// 卡片内容实际可用宽度：整卡固定宽减去两侧留白。九宫格用它做定长格子的算术依据——见下方
    /// `photoSection` 的文档，这里不依赖 HStack/VStack 对齐子视图宽度的隐式协商。
    private var contentWidth: CGFloat { Self.width - Self.horizontalPadding * 2 }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            header
            if !excerpts.isEmpty { excerptBlock }
            if !photos.isEmpty { photoSection }
            brandFooter
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(Self.horizontalPadding)
        .frame(width: Self.width, alignment: .leading)
        .background(ZXTheme.rice)
        .environment(\.colorScheme, .light)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("知 行 旅 记")
                .font(.caption2.weight(.semibold))
                .tracking(3)
                .foregroundStyle(ZXTheme.cinnabar)
            Text(title)
                .font(.system(.title2, design: .serif, weight: .bold))
                .foregroundStyle(ZXTheme.ink)
            Text(dateRange).font(.subheadline).foregroundStyle(.secondary)
            if !cityNames.isEmpty {
                Text(cityNames.joined(separator: " · "))
                    .font(.subheadline.weight(.semibold))
            }
        }
    }

    private var excerptBlock: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(excerpts.enumerated()), id: \.offset) { _, excerpt in
                Text(excerpt)
                    .font(.system(.callout, design: .serif))
                    .lineSpacing(5)
            }
        }
    }

    /// 九宫格版式分档（规格原文）：1 张通栏（保留原图比例裁剪展示，不强制方形）；2–4 两列 /
    /// ≥5 三列，均为等宽正方格。
    ///
    /// 用手工 VStack/HStack + 预先按 `contentWidth` 算好的定长格子，不用 `LazyVGrid`——
    /// `ImageRenderer` 是离屏渲染，从未真正出现在某个 `ScrollView` 的可见视口里，而 Lazy 容器
    /// 具现子视图的时机依赖真实视口回调，脱离 ScrollView 后有留白/残缺渲染的已知风险；九宫格
    /// 至多 9 张、数量很小，手工布局既避开这个风险又足够简单。格子宽度也不依赖 HStack 对齐
    /// 等宽子视图的隐式协商（那套协商对 `.aspectRatio` 类子视图存在已知的自洽性问题），
    /// 而是直接用 `contentWidth` 做算术算出确定的边长，再用显式 `.frame(width:height:)` 钉死。
    @ViewBuilder
    private var photoSection: some View {
        let columns = Self.columns(forPhotoCount: photos.count)
        if columns == 1, let only = photos.first {
            singleBanner(only)
        } else {
            gridRows(columns: columns)
        }
    }

    private func singleBanner(_ image: UIImage) -> some View {
        let height = contentWidth * 3 / 4
        return Image(uiImage: image)
            .resizable()
            .scaledToFill()
            .frame(width: contentWidth, height: height)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .clipped()
    }

    private func gridRows(columns: Int) -> some View {
        let side = (contentWidth - CGFloat(columns - 1) * Self.gridSpacing) / CGFloat(columns)
        let rows = stride(from: 0, to: photos.count, by: columns)
            .map { Array(photos[$0 ..< min($0 + columns, photos.count)]) }
        return VStack(spacing: Self.gridSpacing) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(spacing: Self.gridSpacing) {
                    ForEach(Array(row.enumerated()), id: \.offset) { _, image in
                        photoCell(image, side: side)
                    }
                    if row.count < columns { Spacer(minLength: 0) } // 末行不足一整行时靠左摆放，不拉伸
                }
            }
        }
    }

    private func photoCell(_ image: UIImage, side: CGFloat) -> some View {
        Image(uiImage: image)
            .resizable()
            .scaledToFill()
            .frame(width: side, height: side)
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .clipped()
    }

    private var brandFooter: some View {
        VStack(spacing: 10) {
            Rectangle().fill(ZXTheme.oldGold.opacity(0.45)).frame(height: 1)
            HStack(alignment: .center, spacing: 10) {
                // 卡底即宣纸米色,透明底图形标直接落上去,无需再垫底砖
                Image("BrandMark")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 36, height: 36)
                VStack(alignment: .leading, spacing: 2) {
                    Text("知行")
                        .font(.system(.headline, design: .serif, weight: .bold))
                        .foregroundStyle(ZXTheme.pine)
                    Text("一张有故事的中国地图").font(.caption2).foregroundStyle(.tertiary)
                }
                Spacer()
                if let qr {
                    Image(uiImage: qr).resizable().frame(width: 64, height: 64)
                }
            }
        }
    }

    /// 九宫格版式分档（规格原文）：1 张通栏；2–4 两列；≥5 三列。0 张时上层 `!photos.isEmpty`
    /// 已经把整段跳过，这里不必单独处理 0——归入 1 张分支只是让函数在整个输入域上都有定义。
    /// `nonisolated`：纯函数，不碰任何实例状态——`TripShareCard` 因为 `View` 协议推导默认整型
    /// MainActor 隔离，不加这个标注会导致单测里的同步、非 MainActor 调用点产生新警告。
    nonisolated static func columns(forPhotoCount count: Int) -> Int {
        switch count {
        case 0, 1: return 1
        case 2 ... 4: return 2
        default: return 3
        }
    }
}
