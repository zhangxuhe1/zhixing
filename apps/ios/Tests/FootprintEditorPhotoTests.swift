import XCTest
@testable import Zhixing

/// 编辑器照片分区的契约（spec：2026-07-18 足迹照片编辑 §4/§5）：
/// 宫格定框必须走 Color.clear 写法、拖拽排序用 draggable/dropDestination、
/// 上传显式声明字节未脱敏（sanitized: false）且不许携带任何照片 meta（takenAt/lat/lng），
/// 保存链路必须接入草稿的进度固化（markRemoved 等），部分失败重试不重复已成步骤。
/// 源码断言惯例，先例 PhotoGridTests。
final class FootprintEditorPhotoTests: XCTestCase {
    private func source(_ relativePath: String) throws -> String {
        let testsDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let sourceURL = testsDirectory.deletingLastPathComponent()
            .appendingPathComponent("Zhixing/\(relativePath)")
        return try String(contentsOf: sourceURL, encoding: .utf8)
    }

    /// 宫格与交互标记：定框 Color.clear（PhotoWallSection 踩坑约定）、拖拽两件套、
    /// 封面菜单项；格子身份严禁绑 offset（拖拽重排后 offset 身份会错乱复用视图）。
    func testGridFramingAndDragMarkers() throws {
        let editor = try source("Footprint/FootprintEditor.swift")

        XCTAssertTrue(editor.contains("Color.clear"))
        XCTAssertTrue(editor.contains(".draggable("))
        XCTAssertTrue(editor.contains(".dropDestination("))
        XCTAssertTrue(editor.contains("\"设为封面\""))
        XCTAssertFalse(editor.contains("id: \\.offset"))
    }

    /// 保存链路：上传必须显式 sanitized: false（相册原始字节含 EXIF，须重编码脱敏），
    /// 且编辑器上传绝不携带 takenAt/lat/lng 等照片 meta；进度固化（markRemoved）
    /// 确实接入保存链路——DELETE 成功即固化，部分失败重试不再重复删除。
    func testSaveChainPrivacyAndProgressMarkers() throws {
        let editor = try source("Footprint/FootprintEditor.swift")

        XCTAssertTrue(editor.contains("sanitized: false"))
        XCTAssertTrue(editor.contains("markRemoved"))
        XCTAssertFalse(editor.contains("takenAt:"))
        // 保存期间整表锁交互:多个 await 悬挂点期间草稿不得被篡改,否则 ③ 快照/④ 实时读取脱节。
        XCTAssertTrue(editor.contains(".disabled(saving)"))
        XCTAssertTrue(editor.contains("guard !saving"))
    }

    /// 丢图窗口封堵（终审 Finding）：iCloud 卸载图的 loadTransferable 可迟到数秒，append 落在
    /// 保存链路 ③ 快照之后会错过上传、成功 dismiss 即静默丢图。两道闸都要在：
    /// ① 装载 Task 保存期间拒收——编辑器内联 guard !saving else、detail 侧 guard !editorSaving；
    /// ② performSave 的结构性兜底——③ 后 pendingAdditions 仍非空即报错留守编辑器，禁止 dismiss。
    func testLateLoadGuardAndSaveBackstopMarkers() throws {
        let editor = try source("Footprint/FootprintEditor.swift")
        let detail = try source("Footprint/FootprintDetailView.swift")

        XCTAssertTrue(editor.contains("guard !saving else"))
        XCTAssertTrue(editor.contains("guard draft.pendingAdditions.isEmpty"))
        XCTAssertTrue(editor.contains("有新选的照片尚未上传，请再次保存"))
        XCTAssertTrue(detail.contains("guard !editorSaving"))
    }

    /// 满额提示(走查修复 A):配额耗尽时"+"格不再渲染,必须留下解释文案,
    /// 否则消失会被误读为 bug;文案里的上限数字必须走 ZXLimit 常量插值,不得写死。
    func testFullQuotaHintMarkers() throws {
        let editor = try source("Footprint/FootprintEditor.swift")

        XCTAssertTrue(editor.contains("照片最多"))
        XCTAssertTrue(editor.contains("ZXLimit.footprintPhotos"))
    }

    /// Catalyst 选图舞步(Task 8):系统图库必须从详情页根层呈现(.presentation 全窗样式,
    /// MapScreen↔Composer 先例),选张上限用提升到 detail 侧的 editorPickerLimit;
    /// 编辑器侧 Catalyst 分支通过 onChoosePhotos 回调发起舞步,✕ 删除角标悬停显隐(.onHover)。
    func testCatalystPickerLiftingAndHoverMarkers() throws {
        let detail = try source("Footprint/FootprintDetailView.swift")
        let editor = try source("Footprint/FootprintEditor.swift")

        XCTAssertTrue(detail.contains(".photosPickerStyle(.presentation)"))
        XCTAssertTrue(detail.contains("maxSelectionCount: editorPickerLimit"))
        XCTAssertTrue(editor.contains("onChoosePhotos"))
        XCTAssertTrue(editor.contains(".onHover"))
    }
}
