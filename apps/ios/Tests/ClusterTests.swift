import XCTest
@testable import Zhixing

final class ClusterTests: XCTestCase {
    // 测试地点：什刹海(街区) 与 北京市(城市) 同城；济南市(城市) 异地
    let pins = [
        Pin(id: "shichahai", name: "什刹海", level: "DISTRICT", parentId: "beijing",
            lat: 39.9403, lng: 116.383, cardCount: 1),
        Pin(id: "beijing", name: "北京市", level: "CITY", parentId: nil,
            lat: 39.9042, lng: 116.4074, cardCount: 1),
        Pin(id: "jinan", name: "济南市", level: "CITY", parentId: nil,
            lat: 36.651, lng: 117.12, cardCount: 0),
    ]

    func date(_ s: String) -> Date {
        ISO8601DateFormatter().date(from: s)!
    }

    /// EXIF 坐标是 WGS-84：从 GCJ 目标位置一阶反推 WGS 拍摄点（偏移场平滑，误差米级），
    /// 模拟“真实拍摄于该地”的照片——clusterAssets 内部会 wgs2gcj 转回来匹配。
    /// 境外点（如太平洋）wgs2gcj 恒等，反推也恒等，可统一使用。
    func asset(_ id: String, _ iso: String, gcjLat: Double, gcjLng: Double) -> AssetMeta {
        let g = wgs2gcj(lat: gcjLat, lng: gcjLng)
        return AssetMeta(id: id, takenAt: date(iso),
                         lat: 2 * gcjLat - g.lat, lng: 2 * gcjLng - g.lng)
    }

    func testHaversineKnownDistance() {
        // 什刹海到北京市中心约 4.6km
        let d = haversineMeters(lat1: 39.9403, lng1: 116.383, lat2: 39.9042, lng2: 116.4074)
        XCTAssertEqual(d, 4600, accuracy: 500)
    }

    func testNearestPinPrefersDeeperLevel() {
        // 银锭桥（什刹海内）：距什刹海 <1km 命中街区；距北京市中心 ~4.6km 也在 30km 内——应选街区
        let pin = nearestPin(lat: 39.9405, lng: 116.3838, pins: pins)
        XCTAssertEqual(pin?.id, "shichahai")
        // 通州（远离什刹海 3km 半径，但在北京 30km 内）→ 归到北京市
        XCTAssertEqual(nearestPin(lat: 39.909, lng: 116.656, pins: pins)?.id, "beijing")
        // 太平洋上 → 无匹配
        XCTAssertNil(nearestPin(lat: 20.0, lng: 150.0, pins: pins))
    }

    func testClusterSplitsByGapAndSkipsUnmatched() {
        let assets = [
            asset("a1", "2024-05-01T10:00:00Z", gcjLat: 39.9405, gcjLng: 116.3838),
            asset("a2", "2024-05-01T12:00:00Z", gcjLat: 39.9401, gcjLng: 116.3829),
            asset("a3", "2024-10-01T09:00:00Z", gcjLat: 39.9404, gcjLng: 116.3833), // 隔 5 个月：拆段
            asset("b1", "2024-06-01T09:00:00Z", gcjLat: 36.6512, gcjLng: 117.1201),
            asset("x1", "2024-07-01T09:00:00Z", gcjLat: 20.0, gcjLng: 150.0),       // 无匹配：跳过
        ]
        let groups = clusterAssets(assets, pins: pins)
        XCTAssertEqual(groups.count, 3) // 什刹海 5 月、什刹海 10 月、济南 6 月
        let shichahai = groups.filter { $0.pin.id == "shichahai" }
        XCTAssertEqual(shichahai.map(\.assets.count).sorted(), [1, 2])
        XCTAssertEqual(groups.filter { $0.pin.id == "jinan" }.count, 1)
    }
}
