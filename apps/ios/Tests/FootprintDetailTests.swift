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
}
