import XCTest

/// 容易被视觉重构悄悄破坏的交互契约护栏。
///
/// 这些行为由系统控件和 SwiftUI 命中测试共同决定，难以用纯模型测试覆盖；
/// 源码断言用于锁住关键配置，最终观感仍需模拟器或真机走查。
final class InteractionDesignTests: XCTestCase {
    private func source(_ relativePath: String) throws -> String {
        let testsDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let sourceURL = testsDirectory.deletingLastPathComponent()
            .appendingPathComponent("Zhixing/\(relativePath)")
        return try String(contentsOf: sourceURL, encoding: .utf8)
    }

    func testCatalystWindowTitleStaysEmpty() throws {
        let appStores = try source("Core/AppStores.swift")

        XCTAssertTrue(appStores.contains("scene.titlebar?.titleVisibility = .hidden"))
        XCTAssertFalse(appStores.contains("scene.title = \"\""))
        XCTAssertFalse(appStores.contains("scene.title = \"知行\""))
    }

    func testSearchResultUsesFullWidthRectangularHitArea() throws {
        let search = try source("Search/SearchSheet.swift")

        XCTAssertTrue(search.contains(".frame(maxWidth: .infinity, minHeight: 72, alignment: .leading)"))
        XCTAssertTrue(search.contains(".contentShape(Rectangle())"))
        XCTAssertTrue(search.contains(".listRowInsets(EdgeInsets())"))
    }

    func testPhotoPickerShowsOrderedSelectionAndPersistentConfirmation() throws {
        let composer = try source("Footprint/FootprintComposer.swift")

        XCTAssertTrue(composer.contains("selectionBehavior: .ordered"))
        XCTAssertTrue(composer.contains("checkmark.circle.fill"))
        XCTAssertTrue(composer.contains("已选照片会显示选择顺序"))
    }

    func testCatalystKeepsComposerAsSheetAndPresentsPhotoPickerAtWindowRoot() throws {
        let composer = try source("Footprint/FootprintComposer.swift")
        let map = try source("Map/MapScreen.swift")
        let drawer = try source("Place/PlaceDrawer.swift")

        XCTAssertTrue(composer.contains("Button(action: onChoosePhotos)"))
        XCTAssertFalse(composer.contains(".photosPickerStyle(.inline)"))
        XCTAssertFalse(composer.contains("CatalystPhotoPickerSheet"))
        XCTAssertTrue(map.contains(".sheet(item: $composerPin"))
        XCTAssertFalse(map.contains(".fullScreenCover(item: $composerPin)"))
        XCTAssertTrue(map.contains("isPresented: $showComposerPhotoPicker"))
        XCTAssertTrue(map.contains("selection: $composerPhotoItems"))
        XCTAssertTrue(map.contains(".photosPickerStyle(.presentation)"))
        XCTAssertTrue(map.contains("restoreComposerAfterPhotoPicker = true"))
        XCTAssertTrue(map.contains("composerPin = nil"))
        XCTAssertTrue(map.contains("composerPin = pin"))
        XCTAssertTrue(map.contains("text: $composerText"))
        XCTAssertTrue(map.contains("date: $composerDate"))
        XCTAssertTrue(map.contains("isPublic: $composerIsPublic"))
        XCTAssertTrue(map.contains("error: $composerError"))
        XCTAssertTrue(map.contains("createdFootprint: $composerCreatedFootprint"))
        XCTAssertTrue(map.contains("pendingComposerPin = pin"))
        XCTAssertTrue(drawer.contains("#if !targetEnvironment(macCatalyst)"))
        XCTAssertTrue(drawer.contains("private func requestComposeFootprint()"))
        XCTAssertTrue(drawer.contains("onComposeFootprint()"))
    }
}
