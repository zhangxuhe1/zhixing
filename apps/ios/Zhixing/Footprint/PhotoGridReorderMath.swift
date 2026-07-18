import CoreGraphics

/// 3 列定宽宫格的拖拽重排几何(纯值计算,不碰 UI;可单测)。
/// 为什么自绘:Transferable 拖放(.draggable/.dropDestination)在 Form(=List)行内
/// 不受支持——lift 快照整个 cell、行内落点永不回调(Apple 论坛 730367),只能绕开
/// UIKit 拖放会话,用手势 + 几何换算实现。
struct PhotoGridReorderMath {
    /// 方格边长。
    let cellSide: CGFloat
    /// 格间距(横纵同值)。
    let spacing: CGFloat
    /// 列数(编辑器为 3)。
    let columns: Int

    /// 槽距:相邻槽位 origin 的间隔(边长 + 间距)。
    private var slotStride: CGFloat { cellSide + spacing }

    /// 第 index 个槽位的左上角坐标(宫格局部坐标系,原点 = 首格左上角)。
    func slotOrigin(_ index: Int) -> CGPoint {
        CGPoint(
            x: CGFloat(index % columns) * slotStride,
            y: CGFloat(index / columns) * slotStride)
    }

    /// 拖拽换算:被拖格中心(起点槽心 + 手势位移)就近落在哪个槽位。
    /// 换算基于手势起点的绝对几何,与拖拽过程中条目实时重排无关;
    /// 列/行先各自钳制,再按 count 钳制——末行不满时,几何上的空槽落点收敛到最后一格。
    func targetIndex(startIndex: Int, translation: CGSize, count: Int) -> Int {
        let start = slotOrigin(startIndex)
        let center = CGPoint(
            x: start.x + cellSide / 2 + translation.width,
            y: start.y + cellSide / 2 + translation.height)
        let col = min(max(Int(((center.x - cellSide / 2) / slotStride).rounded()), 0), columns - 1)
        let row = max(0, Int(((center.y - cellSide / 2) / slotStride).rounded()))
        return max(0, min(row * columns + col, count - 1))
    }

    /// 被拖格的显示补偿:实时重排把它挪进 currentIndex 槽位后布局位置随之跳变,
    /// 用 translation 扣除该位移(slotOrigin 之差),保证格子始终跟手;
    /// current == start(尚未换槽)时即原始位移。
    func liftOffset(startIndex: Int, currentIndex: Int, translation: CGSize) -> CGSize {
        let start = slotOrigin(startIndex)
        let current = slotOrigin(currentIndex)
        return CGSize(
            width: translation.width - (current.x - start.x),
            height: translation.height - (current.y - start.y))
    }
}
