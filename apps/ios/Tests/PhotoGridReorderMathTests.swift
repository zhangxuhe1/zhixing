import XCTest
@testable import Zhixing

/// PhotoGridReorderMath 纯几何矩阵(编辑器照片宫格的自绘拖拽重排):
/// - slotOrigin:index → 槽位左上角(3 列定宽,间距横纵同值)。
/// - targetIndex:被拖格中心(起点槽心 + 手势位移)就近落槽;列/行先各自钳制,
///   再按 count 钳制——末行不满时空槽落点收敛到最后一格。换算只依赖手势起点的
///   绝对几何,与拖拽过程中条目实时重排无关。
/// - liftOffset:实时重排把被拖格挪进新槽位后的显示补偿(translation 减布局位移),
///   保证被拖格始终跟手。
/// 全部用例手算期望、数值字面量断言(cellSide 100 + spacing 4 → 槽距 104)。
final class PhotoGridReorderMathTests: XCTestCase {
    private let math = PhotoGridReorderMath(cellSide: 100, spacing: 4, columns: 3)

    // MARK: - slotOrigin

    // 槽位坐标:col = index % 3、row = index / 3,步距 = 边长 + 间距 = 104。
    func testSlotOriginByRowAndColumn() {
        XCTAssertEqual(math.slotOrigin(0), CGPoint(x: 0, y: 0))
        XCTAssertEqual(math.slotOrigin(2), CGPoint(x: 208, y: 0))
        XCTAssertEqual(math.slotOrigin(4), CGPoint(x: 104, y: 104))
        XCTAssertEqual(math.slotOrigin(7), CGPoint(x: 104, y: 208))
    }

    // MARK: - targetIndex

    // 原位微动(位移不过半槽距)不换槽。
    func testTinyTranslationKeepsSlot() {
        XCTAssertEqual(math.targetIndex(startIndex: 4, translation: CGSize(width: 3, height: -2), count: 9), 4)
        XCTAssertEqual(math.targetIndex(startIndex: 0, translation: CGSize(width: 48, height: 0), count: 9), 0)
    }

    // 右移一格:整槽距位移换到右邻;过半槽距(60 > 52)即已换槽。
    func testMoveRightOneColumn() {
        XCTAssertEqual(math.targetIndex(startIndex: 0, translation: CGSize(width: 104, height: 0), count: 9), 1)
        XCTAssertEqual(math.targetIndex(startIndex: 0, translation: CGSize(width: 60, height: 0), count: 9), 1)
    }

    // 左移一格。
    func testMoveLeftOneColumn() {
        XCTAssertEqual(math.targetIndex(startIndex: 1, translation: CGSize(width: -104, height: 0), count: 9), 0)
    }

    // 下移一格(跨行:第 2 格拖到第 5 格),带少量横向抖动仍落同一槽。
    func testMoveDownOneRowAcrossRows() {
        XCTAssertEqual(math.targetIndex(startIndex: 1, translation: CGSize(width: 0, height: 104), count: 9), 4)
        XCTAssertEqual(math.targetIndex(startIndex: 1, translation: CGSize(width: 10, height: 104), count: 9), 4)
    }

    // 上移一格。
    func testMoveUpOneRow() {
        XCTAssertEqual(math.targetIndex(startIndex: 4, translation: CGSize(width: 0, height: -104), count: 9), 1)
    }

    // 大幅拖出宫格右下:列钳到 2、行随位移增长,整体钳到 count−1。
    func testDragFarBottomRightClampsToLastIndex() {
        XCTAssertEqual(math.targetIndex(startIndex: 0, translation: CGSize(width: 1000, height: 1000), count: 9), 8)
    }

    // 大幅拖出宫格左上:列/行各钳到 0,整体落到 0。
    func testDragFarTopLeftClampsToZero() {
        XCTAssertEqual(math.targetIndex(startIndex: 8, translation: CGSize(width: -1000, height: -1000), count: 9), 0)
    }

    // 末行不满:斜对角拖向末行空槽(几何上的第 9 格),钳到最后一格 6。
    func testPartialLastRowDiagonalClampsToLastEntry() {
        XCTAssertEqual(math.targetIndex(startIndex: 2, translation: CGSize(width: 0, height: 208), count: 7), 6)
    }

    // 末行不满:横向拖过末行最后一格(几何上的第 6 格空槽),同样钳到 count−1。
    func testPartialLastRowHorizontalClampsToLastEntry() {
        XCTAssertEqual(math.targetIndex(startIndex: 3, translation: CGSize(width: 208, height: 0), count: 5), 4)
    }

    // MARK: - liftOffset

    // 未发生重排(current == start):补偿即原始位移。
    func testLiftOffsetWithoutReorderIsTranslation() {
        XCTAssertEqual(
            math.liftOffset(startIndex: 2, currentIndex: 2, translation: CGSize(width: 33, height: -7)),
            CGSize(width: 33, height: -7))
    }

    // 同行右移一槽后:布局位移 (104, 0) 被扣除。
    func testLiftOffsetCompensatesSameRowMove() {
        XCTAssertEqual(
            math.liftOffset(startIndex: 0, currentIndex: 1, translation: CGSize(width: 120, height: 5)),
            CGSize(width: 16, height: 5))
    }

    // 上移跨行(4 → 1):布局位移 (0, −104) 被扣除。
    func testLiftOffsetCompensatesUpwardCrossRowMove() {
        XCTAssertEqual(
            math.liftOffset(startIndex: 4, currentIndex: 1, translation: CGSize(width: -8, height: -110)),
            CGSize(width: -8, height: -6))
    }

    // 下移跨行且换列(1 → 5):布局位移 (104, 104) 被扣除。
    func testLiftOffsetCompensatesDiagonalCrossRowMove() {
        XCTAssertEqual(
            math.liftOffset(startIndex: 1, currentIndex: 5, translation: CGSize(width: 110, height: 120)),
            CGSize(width: 6, height: 16))
    }
}
