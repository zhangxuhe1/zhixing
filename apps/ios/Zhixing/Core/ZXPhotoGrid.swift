import SwiftUI

/// 详情页照片区的自适应宫格，取代整宽横幅竖排——横幅在宽窗口下是约 2.6:1 的宽扁框
/// + scaledToFill，方图/竖图只剩中间一条横带，且每张独占约 300pt 纵向空间。
/// 按张数三档：1 张=整宽 4:3 题图、2 张=两格 1:1 对分、≥3 张=三列 1:1 宫格。
/// 点格子回调下标，全屏浏览由调用方接 ZXPhotoBrowser（组件不含业务文案，PhotoGridTests 有断言）。
/// 设计：docs/superpowers/specs/2026-07-17-photo-grid-design.md
struct ZXPhotoGrid: View {
    let photoIds: [String]
    let onTap: (Int) -> Void

    /// 档位：1 张题图 / 2 张对分 / ≥3 张宫格。
    enum Layout { case single, pair, grid }

    /// `nonisolated` 纯函数（同 `ZXPhotoThumbRow.overflow` 惯例）；
    /// 0 张由 body 的空视图分支短路，本函数只需对 ≥1 有定义。
    nonisolated static func layout(for count: Int) -> Layout {
        switch count {
        case 1: .single
        case 2: .pair
        default: .grid
        }
    }

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 4), count: 3)

    var body: some View {
        if photoIds.isEmpty {
            EmptyView()
        } else {
            switch Self.layout(for: photoIds.count) {
            case .single:
                // 单张无 ForEach，显式 .id 绑照片 id，语义与下方 id: \.element 一致。
                tile(index: 0, aspect: 4.0 / 3.0, cornerRadius: 18)
                    .id(photoIds[0])
            case .pair:
                HStack(spacing: 4) {
                    ForEach(Array(photoIds.enumerated()), id: \.element) { index, _ in
                        tile(index: index, aspect: 1, cornerRadius: 8)
                    }
                }
            case .grid:
                LazyVGrid(columns: columns, spacing: 4) {
                    // 格子身份绑照片 id 而非位置：AuthedPhotoView 的 @State 图片缓存跟随视图身份，
                    // 按位置认身份会在照片删除/重排后让存活位置继续显示旧图（同 ZXPhotoThumbRow 护栏）。
                    ForEach(Array(photoIds.enumerated()), id: \.element) { index, _ in
                        tile(index: index, aspect: 1, cornerRadius: 8)
                    }
                }
            }
        }
    }

    /// 定框裁切的尺寸权威必须是外框而非 AuthedPhotoView 自身（PhotoWallSection.photoCell 踩坑注释）：
    /// 其 loaded 分支是 scaledToFill，直接 .aspectRatio(_, .fit) 只变换提案、上报的仍是子视图的
    /// 覆盖尺寸；Color.clear 按提案定框，图作 overlay，溢出部分才真正被 clip 掉。
    private func tile(index: Int, aspect: CGFloat, cornerRadius: CGFloat) -> some View {
        Button { onTap(index) } label: {
            Color.clear
                .aspectRatio(aspect, contentMode: .fit)
                .overlay { AuthedPhotoView(photoId: photoIds[index]) }
                .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("第 \(index + 1) 张照片，共 \(photoIds.count) 张，点按全屏查看")
    }
}
