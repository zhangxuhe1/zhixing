import XCTest
@testable import Zhixing

/// 足迹详情页与通用全屏浏览器的交互契约（spec：2026-07-17-footprint-detail-design.md）：
/// 私密足迹的"读"路径——列表点行进详情，编辑降级为详情页右上角入口；
/// 全屏照片浏览器抽成通用组件，照片墙与足迹详情共用。
final class FootprintDetailTests: XCTestCase {
    private func source(_ relativePath: String) throws -> String {
        let testsDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let sourceURL = testsDirectory.deletingLastPathComponent()
            .appendingPathComponent("Zhixing/\(relativePath)")
        return try String(contentsOf: sourceURL, encoding: .utf8)
    }

    /// 照片墙必须复用通用浏览器，私有 PhotoWallBrowser 不复存在；
    /// 通用组件不得内置「查看故事」这类业务按钮（底栏由调用方注入）。
    func testPhotoWallUsesSharedBrowser() throws {
        let browser = try source("Core/ZXPhotoBrowser.swift")
        let wall = try source("Place/PhotoWallSection.swift")

        XCTAssertTrue(wall.contains("ZXPhotoBrowser("))
        XCTAssertFalse(wall.contains("struct PhotoWallBrowser"))
        XCTAssertFalse(browser.contains("查看故事"))
        // 页身份必须绑照片 id 而非位置：AuthedPhotoView 的 @State 缓存跟随视图身份
        //（同 ZXPhotoThumbRow 的护栏理由），不得回退按 offset。
        XCTAssertTrue(browser.contains("id: \\.element"))
        XCTAssertFalse(browser.contains("id: \\.offset"))
    }

    /// 详情页契约：编辑入口在工具栏、照片可全屏浏览、公开足迹显示获赞/浏览统计、
    /// 编辑弹层内删除后等弹层收起再退栈（串行接手，同 PhotoWallSection 惯例）、modal 挂 appStores。
    func testDetailKeepsEditEntryBrowserAndStats() throws {
        let detail = try source("Footprint/FootprintDetailView.swift")

        XCTAssertTrue(detail.contains("FootprintEditor(footprint:"))
        XCTAssertTrue(detail.contains("ZXPhotoBrowser("))
        XCTAssertTrue(detail.contains(".fullScreenCover"))
        XCTAssertTrue(detail.contains("获赞") && detail.contains("浏览"))
        XCTAssertTrue(detail.contains(".onDisappear"))
        XCTAssertTrue(detail.contains(".appStores()"))
    }

    /// 浏览器操控件契约（spec：2026-07-17-photo-grid-design.md 追记）：左右切换钮 + 首末页隐藏
    /// + 统一高对比样式（thinMaterial 不得回潮）+ 悬停显隐仅限 Catalyst。
    func testBrowserKeepsNavCloseAndHoverChrome() throws {
        let browser = try source("Core/ZXPhotoBrowser.swift")

        XCTAssertTrue(browser.contains("chevron.left"))
        XCTAssertTrue(browser.contains("chevron.right"))
        XCTAssertTrue(browser.contains("上一张"))
        XCTAssertTrue(browser.contains("下一张"))
        XCTAssertTrue(browser.contains("selection > 0"))
        XCTAssertTrue(browser.contains("selection < photoIds.count - 1"))
        XCTAssertTrue(browser.contains("targetEnvironment(macCatalyst)"))
        XCTAssertTrue(browser.contains(".onHover"))
        XCTAssertFalse(browser.contains(".thinMaterial"))
    }

    /// 无底栏（EmptyView 便捷构造）时绝不能装 safeAreaInset：内容为空视图的 safeAreaInset
    /// 会给主内容提案 0 高并顶对齐（iOS 与 Catalyst 皆然，几何探针实证），
    /// 左右切换/关闭钮全被压到顶部一条；带真实底栏的照片墙路径则必须保留 inset 语义。
    func testBrowserSkipsSafeAreaInsetWhenNoBottomBar() throws {
        let browser = try source("Core/ZXPhotoBrowser.swift")

        XCTAssertTrue(browser.contains("BottomBar.self == EmptyView.self"))
        XCTAssertTrue(browser.contains(".safeAreaInset(edge: .bottom)"))
    }

    /// 分页两护栏（几何探针实证，勿回退）：
    /// 1）页尺寸权威是 Color.clear + overlay + clipped——loaded 分支 scaledToFill 上报覆盖
    ///    尺寸，maxi frame 会把页撑得比分页视口宽、溢出压进邻页（"一屏各显示两张图一部分"）；
    /// 2）按钮翻页无动画瞬切——withAnimation 驱动 selection 与分页落页写回竞态，
    ///    连点漂移/过冲、被打断的过渡停在非整页位置。
    func testBrowserPagesSizedByProposalAndFlipWithoutAnimation() throws {
        let browser = try source("Core/ZXPhotoBrowser.swift")

        XCTAssertTrue(browser.contains(".overlay { AuthedPhotoView(photoId: photoId) }"))
        XCTAssertTrue(browser.contains("selection -= 1") && browser.contains("selection += 1"))
        XCTAssertFalse(browser.contains("withAnimation(.easeInOut(duration: 0.2)) { selection"))
    }

    /// 两处列表入口：点行必须推详情（NavigationLink），不得再直弹编辑器；
    /// 左滑删除保留；无障碍提示从"编辑"改为"查看"。
    func testListRowsPushDetailInsteadOfEditor() throws {
        let me = try source("Me/MeScreen.swift")
        let myMap = try source("Me/MyMapScreen.swift")

        XCTAssertTrue(me.contains("NavigationLink { FootprintDetailView(footprint:"))
        XCTAssertTrue(myMap.contains("NavigationLink { FootprintDetailView(footprint:"))
        XCTAssertFalse(me.contains("FootprintEditor"))
        XCTAssertFalse(myMap.contains("FootprintEditor"))
        XCTAssertTrue(me.contains(".onDelete"))
        XCTAssertTrue(myMap.contains("查看这段足迹"))
        XCTAssertFalse(myMap.contains("编辑这段足迹"))
    }
}
