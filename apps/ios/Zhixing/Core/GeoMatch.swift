import Foundation

/// WGS-84 → GCJ-02（国测局）近似正变换，业界通用逆向拟合实现（eviltransform 系），大陆境内误差米级。
/// 库内 Place 坐标全库 GCJ-02，而 Core Location / 相册 EXIF 是 WGS-84——参与 nearestPin
/// 距离匹配前必须先过这一层；显示链路（MapKit 大陆底图原生 GCJ-02）保持零转换。
/// 粗判国境外的点不偏移，原样返回。
func wgs2gcj(lat: Double, lng: Double) -> (lat: Double, lng: Double) {
    guard lng > 72.004, lng < 137.8347, lat > 0.8293, lat < 55.8271 else { return (lat, lng) }
    let a = 6_378_245.0
    let ee = 0.006_693_421_622_965_943
    let x = lng - 105.0, y = lat - 35.0
    var dLat = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * sqrt(abs(x))
    dLat += (20.0 * sin(6.0 * x * .pi) + 20.0 * sin(2.0 * x * .pi)) * 2.0 / 3.0
    dLat += (20.0 * sin(y * .pi) + 40.0 * sin(y / 3.0 * .pi)) * 2.0 / 3.0
    dLat += (160.0 * sin(y / 12.0 * .pi) + 320.0 * sin(y * .pi / 30.0)) * 2.0 / 3.0
    var dLng = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * sqrt(abs(x))
    dLng += (20.0 * sin(6.0 * x * .pi) + 20.0 * sin(2.0 * x * .pi)) * 2.0 / 3.0
    dLng += (20.0 * sin(x * .pi) + 40.0 * sin(x / 3.0 * .pi)) * 2.0 / 3.0
    dLng += (150.0 * sin(x / 12.0 * .pi) + 300.0 * sin(x / 30.0 * .pi)) * 2.0 / 3.0
    let radLat = lat / 180.0 * .pi
    let magic = 1 - ee * sin(radLat) * sin(radLat)
    let sqrtMagic = sqrt(magic)
    dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * .pi)
    dLng = (dLng * 180.0) / (a / sqrtMagic * cos(radLat) * .pi)
    return (lat + dLat, lng + dLng)
}

func haversineMeters(lat1: Double, lng1: Double, lat2: Double, lng2: Double) -> Double {
    let r = 6_371_000.0
    let dLat = (lat2 - lat1) * .pi / 180
    let dLng = (lng2 - lng1) * .pi / 180
    let a = sin(dLat / 2) * sin(dLat / 2)
        + cos(lat1 * .pi / 180) * cos(lat2 * .pi / 180) * sin(dLng / 2) * sin(dLng / 2)
    return 2 * r * atan2(sqrt(a), sqrt(1 - a))
}

/// 匹配半径按层级（规格书 §4.3 自建地点库半径匹配）
func matchRadius(level: String) -> Double {
    switch level {
    case "DISTRICT", "POI": return 3_000
    case "CITY": return 30_000
    default: return 0 // PROVINCE 不直接挂照片
    }
}

/// 距离/半径比最小者胜出——街区半径小，同时命中时自然优先于城市。
/// 入参 lat/lng 必须与 pins 同为 GCJ-02；WGS-84 来源（GPS/EXIF）先过 wgs2gcj。
func nearestPin(lat: Double, lng: Double, pins: [Pin]) -> Pin? {
    var best: (pin: Pin, score: Double)?
    for pin in pins {
        let radius = matchRadius(level: pin.level)
        guard radius > 0 else { continue }
        let d = haversineMeters(lat1: lat, lng1: lng, lat2: pin.lat, lng2: pin.lng)
        guard d <= radius else { continue }
        let score = d / radius
        if best == nil || score < best!.score { best = (pin, score) }
    }
    return best?.pin
}
