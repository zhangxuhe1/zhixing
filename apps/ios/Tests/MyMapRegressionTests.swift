import MapKit
import SwiftUI
import UIKit
import XCTest
@testable import Zhixing

final class MyMapRegressionTests: XCTestCase {
    private let beijing = Pin(
        id: "beijing", name: "北京市", level: "CITY", parentId: nil,
        lat: 39.9042, lng: 116.4074, cardCount: 1)
    private let jinan = Pin(
        id: "jinan", name: "济南市", level: "CITY", parentId: nil,
        lat: 36.651, lng: 117.12, cardCount: 0)

    /// 回归 Catalyst 空白页：MyMapScreen 初始为 idle→EmptyView，若没有稳定的满屏父容器，
    /// NavigationSplitView 内的目标页会被布局成零尺寸，连 task/navigationTitle 都无法可靠建立。
    func testMyMapScreenKeepsStableFullSizeContainer() throws {
        let testsDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let sourceURL = testsDirectory.deletingLastPathComponent()
            .appendingPathComponent("Zhixing/Me/MyMapScreen.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)

        XCTAssertTrue(source.contains("ZStack {"), "个人地图必须由稳定容器承接加载状态和地图")
        XCTAssertTrue(
            source.contains(".frame(maxWidth: .infinity, maxHeight: .infinity)"),
            "个人地图必须撑满导航目标区域，防止 Catalyst 零尺寸空白页")
        XCTAssertTrue(source.contains("fitPlaceIds: $fitPlaceIds"), "个人地图必须支持自动聚焦足迹")
        XCTAssertTrue(source.contains("onSelect: { selectedPin = $0 }"), "足迹点必须能打开详情")
        XCTAssertTrue(source.contains("await store.load()"), "进入个人地图必须刷新足迹和统计快照")
    }

    /// 宽屏与故事地图对齐使用透明顶栏；iPhone compact 必须把四列统计回落到地图内，
    /// 不能与返回按钮争抢 principal 的有限宽度。
    func testMyMapSummaryAdaptsBetweenToolbarAndCompactOverlay() throws {
        let testsDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let sourceURL = testsDirectory.deletingLastPathComponent()
            .appendingPathComponent("Zhixing/Me/MyMapScreen.swift")
        let source = try String(contentsOf: sourceURL, encoding: .utf8)

        XCTAssertTrue(
            source.contains(".toolbarBackground(navigationBarVisibility, for: .navigationBar)"),
            "导航栏材质必须跟随 compact/regular 布局切换")
        XCTAssertTrue(
            source.contains("ToolbarItem(placement: .principal)"),
            "regular/Catalyst 仍应把统计挂在 principal")
        XCTAssertTrue(source.contains("summaryPlacement == .toolbar"))
        XCTAssertTrue(source.contains("summaryPlacement == .overlay"))
        XCTAssertTrue(source.contains("layout: .toolbar"))
        XCTAssertTrue(source.contains("layout: .overlay"))
    }

    func testMyMapSummaryPlacementKeepsCompactWidthOutOfToolbar() {
        XCTAssertEqual(
            MyMapSummaryPlacement.resolve(horizontalSizeClass: .compact),
            .overlay,
            "iPhone compact 宽度必须使用地图内纵向统计卡")
        XCTAssertEqual(
            MyMapSummaryPlacement.resolve(horizontalSizeClass: .regular),
            .toolbar,
            "regular 宽度应保留桌面式 toolbar 统计")
        XCTAssertEqual(
            MyMapSummaryPlacement.resolve(horizontalSizeClass: nil),
            .toolbar,
            "Catalyst 未提供 size class 时应保持现有宽屏 toolbar 布局")
    }

    @MainActor
    func testCompactSummaryFits375PointViewportAtAccessibilityTextSize() {
        let availableWidth: CGFloat = 375 - 32
        let card = MyMapSummaryCard(
            stats: Stats(footprints: 0, places: 0, cities: 0, provinces: 0),
            footprints: [],
            layout: .overlay)
            .environment(\.dynamicTypeSize, .accessibility3)
        let host = UIHostingController(rootView: card)

        let fitted = host.sizeThatFits(in: CGSize(width: availableWidth, height: 1_000))

        XCTAssertLessThanOrEqual(
            fitted.width, availableWidth + 0.5,
            "compact 统计卡在 375pt 视口和无障碍大字号下不得横向溢出")
        XCTAssertGreaterThan(fitted.height, 0)
    }

    @MainActor
    func testFootprintLayerOnlyAddsLitPlacesAndFitsSinglePlace() {
        var flyTo: Pin?
        var fitPlaceIds: Set<String>?
        let view = MapView(
            pins: [beijing, jinan], litPlaceIds: [beijing.id],
            showHumanities: false, showFootprints: true,
            flyTo: Binding(get: { flyTo }, set: { flyTo = $0 }),
            fitPlaceIds: Binding(get: { fitPlaceIds }, set: { fitPlaceIds = $0 }),
            onSelect: { _ in })
        let coordinator = MapView.Coordinator(view)
        let map = MKMapView(frame: CGRect(x: 0, y: 0, width: 900, height: 700))

        coordinator.sync(map: map)
        let annotations = map.annotations.compactMap { $0 as? PlaceAnnotation }
        XCTAssertEqual(annotations.map(\.pin.id), [beijing.id])
        XCTAssertTrue(annotations.allSatisfy(\.isFootprint))

        coordinator.fit(map: map, placeIds: [beijing.id], animated: false)
        XCTAssertEqual(map.region.center.latitude, beijing.lat, accuracy: 0.001)
        XCTAssertEqual(map.region.center.longitude, beijing.lng, accuracy: 0.001)
        XCTAssertEqual(map.region.span.latitudeDelta, 0.8, accuracy: 0.05)
    }

    @MainActor
    func testFitMultiplePlacesKeepsEveryFootprintVisible() {
        var flyTo: Pin?
        var fitPlaceIds: Set<String>?
        let view = MapView(
            pins: [beijing, jinan], litPlaceIds: [beijing.id, jinan.id],
            showHumanities: false, showFootprints: true,
            flyTo: Binding(get: { flyTo }, set: { flyTo = $0 }),
            fitPlaceIds: Binding(get: { fitPlaceIds }, set: { fitPlaceIds = $0 }),
            onSelect: { _ in })
        let coordinator = MapView.Coordinator(view)
        let map = MKMapView(frame: CGRect(x: 0, y: 0, width: 900, height: 700))

        coordinator.sync(map: map)
        coordinator.fit(map: map, placeIds: [beijing.id, jinan.id], animated: false)

        let visible = map.visibleMapRect
        XCTAssertTrue(visible.contains(MKMapPoint(beijing.latLng)))
        XCTAssertTrue(visible.contains(MKMapPoint(jinan.latLng)))
    }

    @MainActor
    func testFitCollocatedPlacesUsesCityLevelRegion() {
        let duplicate = Pin(
            id: "beijing-duplicate", name: "北京市重复点", level: "POI", parentId: beijing.id,
            lat: beijing.lat, lng: beijing.lng, cardCount: 0)
        var flyTo: Pin?
        var fitPlaceIds: Set<String>?
        let view = MapView(
            pins: [beijing, duplicate], litPlaceIds: [beijing.id, duplicate.id],
            showHumanities: false, showFootprints: true,
            flyTo: Binding(get: { flyTo }, set: { flyTo = $0 }),
            fitPlaceIds: Binding(get: { fitPlaceIds }, set: { fitPlaceIds = $0 }),
            onSelect: { _ in })
        let coordinator = MapView.Coordinator(view)
        let map = MKMapView(frame: CGRect(x: 0, y: 0, width: 900, height: 700))

        coordinator.sync(map: map)
        coordinator.fit(map: map, placeIds: [beijing.id, duplicate.id], animated: false)

        XCTAssertEqual(map.region.center.latitude, beijing.lat, accuracy: 0.001)
        XCTAssertEqual(map.region.center.longitude, beijing.lng, accuracy: 0.001)
        XCTAssertEqual(map.region.span.latitudeDelta, 0.8, accuracy: 0.05)
    }
}

private extension Pin {
    var latLng: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: lat, longitude: lng)
    }
}
