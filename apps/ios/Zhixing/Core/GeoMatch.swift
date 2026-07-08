import Foundation

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

/// 距离/半径比最小者胜出——街区半径小，同时命中时自然优先于城市
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
