import SwiftUI

/// 列表行内的多图缩略：宫格封顶 +N（微博 / X 惯例），取代旧的横滑照片条。
/// 最多渲染 4 张 72×72 缩略图；溢出时最后一格盖遮罩显示「+没露脸的张数」。
/// 好处：总数一眼可知、行高恒定、不与 List 纵向滚动 / 左滑删除抢手势，
/// 且每行图片请求上界从"全部照片"降到 4。
/// 设计：docs/superpowers/specs/2026-07-17-photo-thumb-row-design.md
struct ZXPhotoThumbRow: View {
    let photoIds: [String]

    // `nonisolated`：不可变 Sendable 常量（同 `APIClient` 的 nonisolated static let 惯例），
    // 供下方 nonisolated 纯函数引用。
    nonisolated static let maxVisible = 4

    /// 遮罩数字：总数超过封顶时为"没露脸的张数"（12 张 → +8），否则 nil（不盖遮罩）。
    /// `nonisolated`：纯函数，不碰任何实例状态（同 `TripShareCard.columns` 惯例）——View 协议
    /// 推导默认 MainActor 隔离，不加标注会让单测里的同步、非 MainActor 调用点产生新警告。
    nonisolated static func overflow(total: Int) -> Int? {
        total > maxVisible ? total - maxVisible : nil
    }

    var body: some View {
        let visible = Array(photoIds.prefix(Self.maxVisible))
        let overflowCount = Self.overflow(total: photoIds.count)
        HStack(spacing: 6) {
            ForEach(Array(visible.enumerated()), id: \.offset) { index, photoId in
                AuthedPhotoView(photoId: photoId)
                    .frame(width: 72, height: 72)
                    .overlay {
                        if index == visible.count - 1, let overflowCount {
                            ZStack {
                                Color.black.opacity(0.45)
                                Text("+\(overflowCount)")
                                    .font(.system(size: 17, weight: .semibold))
                                    .foregroundStyle(.white)
                            }
                        }
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
        // 逐张朗读只有"图片、图片…"，合并成一条总数信息对 VoiceOver 更有用。
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("照片，共 \(photoIds.count) 张")
    }
}
