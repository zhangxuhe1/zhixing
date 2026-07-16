import XCTest
@testable import Zhixing

/// wgs2gcj 契约（坐标系修正案）：库内 Place 全 GCJ-02，而 Core Location / 相册 EXIF
/// 是 WGS-84——进入 nearestPin 距离匹配前必须先转 GCJ-02（显示链路仍零转换）。
/// 参考点取自 eviltransform（googollee）公开测试向量，容差 25m：只为抓公式抄错/
/// 符号反向/经纬度调换这类量级错误，不追求逐位复刻。
final class GeoConvertTests: XCTestCase {
    func testOutsideChinaPassthrough() {
        // 东京：粗判国境外不偏移，原样返回
        let p = wgs2gcj(lat: 35.6895, lng: 139.6917)
        XCTAssertEqual(p.lat, 35.6895)
        XCTAssertEqual(p.lng, 139.6917)
    }

    func testKnownReferencePoints() {
        // 上海
        let sh = wgs2gcj(lat: 31.1774276, lng: 121.5272106)
        XCTAssertLessThan(
            haversineMeters(lat1: sh.lat, lng1: sh.lng, lat2: 31.17530398, lng2: 121.53154149),
            25, "上海参考点偏差超 25m")
        // 深圳
        let sz = wgs2gcj(lat: 22.543847, lng: 113.912316)
        XCTAssertLessThan(
            haversineMeters(lat1: sz.lat, lng1: sz.lng, lat2: 22.54079613, lng2: 113.91717648),
            25, "深圳参考点偏差超 25m")
    }

    /// 相册聚类必须把 WGS 查询点转成 GCJ 再匹配：真 pin 放在照片真实位置的 GCJ 坐标上，
    /// 幽灵 pin 恰好放在未转换的 WGS 原始坐标上——不转换会 0 距离命中幽灵点，转换后命中真点。
    func testClusterAssetsMatchesGcjPinNotWgsGhost() {
        let wgsLat = 31.1774276, wgsLng = 121.5272106
        let gcj = wgs2gcj(lat: wgsLat, lng: wgsLng)
        let ghostPin = Pin(id: "ghost", name: "幽灵点", level: "POI", parentId: nil,
                           lat: wgsLat, lng: wgsLng, cardCount: 0)
        let realPin = Pin(id: "real", name: "真点", level: "POI", parentId: nil,
                          lat: gcj.lat, lng: gcj.lng, cardCount: 0)
        let asset = AssetMeta(id: "a1", takenAt: .now, lat: wgsLat, lng: wgsLng)

        let groups = clusterAssets([asset], pins: [ghostPin, realPin])

        XCTAssertEqual(groups.count, 1)
        XCTAssertEqual(groups.first?.pin.id, "real")
    }
}
