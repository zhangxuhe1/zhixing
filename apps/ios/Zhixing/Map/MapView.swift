import MapKit
import SwiftUI

final class PlaceAnnotation: NSObject, MKAnnotation {
    let pin: Pin
    let isFootprint: Bool
    init(pin: Pin, isFootprint: Bool) {
        self.pin = pin
        self.isFootprint = isFootprint
    }
    var coordinate: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: pin.lat, longitude: pin.lng)
    }
    var title: String? { pin.name }
}

struct MapView: UIViewRepresentable {
    let pins: [Pin]
    let litPlaceIds: Set<String>
    let showHumanities: Bool
    let showFootprints: Bool
    @Binding var flyTo: Pin?
    @Binding var fitPlaceIds: Set<String>?
    var onSelect: (Pin) -> Void

    func makeUIView(context: Context) -> MKMapView {
        let map = MKMapView()
        map.delegate = context.coordinator
        map.register(MKMarkerAnnotationView.self,
                     forAnnotationViewWithReuseIdentifier: MKMapViewDefaultAnnotationViewReuseIdentifier)
        map.register(MKMarkerAnnotationView.self,
                     forAnnotationViewWithReuseIdentifier: MKMapViewDefaultClusterAnnotationViewReuseIdentifier)
        map.pointOfInterestFilter = .excludingAll
        map.setRegion(MKCoordinateRegion(
            center: CLLocationCoordinate2D(latitude: 36.0, longitude: 105.0),
            span: MKCoordinateSpan(latitudeDelta: 32, longitudeDelta: 32)), animated: false)
        return map
    }

    func updateUIView(_ map: MKMapView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.sync(map: map)
        if let target = flyTo {
            map.setRegion(MKCoordinateRegion(
                center: CLLocationCoordinate2D(latitude: target.lat, longitude: target.lng),
                span: MKCoordinateSpan(latitudeDelta: 0.08, longitudeDelta: 0.08)), animated: true)
            DispatchQueue.main.async { flyTo = nil }
        }
        if let placeIds = fitPlaceIds {
            context.coordinator.fit(map: map, placeIds: placeIds)
            DispatchQueue.main.async { fitPlaceIds = nil }
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, MKMapViewDelegate {
        var parent: MapView
        private var syncedKey = ""
        init(_ parent: MapView) { self.parent = parent }

        /// 数据没变就不重建标注（updateUIView 会被 SwiftUI 频繁调用）
        func sync(map: MKMapView) {
            var hasher = Hasher()
            hasher.combine(parent.pins.map(\.id))
            hasher.combine(parent.litPlaceIds)
            hasher.combine(parent.showHumanities)
            hasher.combine(parent.showFootprints)
            let key = String(hasher.finalize())
            guard key != syncedKey else { return }
            syncedKey = key
            map.removeAnnotations(map.annotations)
            var annotations: [PlaceAnnotation] = []
            if parent.showHumanities {
                annotations += parent.pins.filter { $0.cardCount > 0 }
                    .map { PlaceAnnotation(pin: $0, isFootprint: false) }
            }
            if parent.showFootprints {
                annotations += parent.pins.filter { parent.litPlaceIds.contains($0.id) }
                    .map { PlaceAnnotation(pin: $0, isFootprint: true) }
            }
            map.addAnnotations(annotations)
        }

        /// 把指定地点完整收进视口。一个点使用城市级跨度，多个点按地理包围盒缩放，并为顶部统计卡、
        /// 底部图例和右侧控制按钮留出安全边距，避免“点虽然在地图里、却被浮层挡住”。
        func fit(map: MKMapView, placeIds: Set<String>, animated: Bool = true) {
            let targets = map.annotations.compactMap { annotation -> PlaceAnnotation? in
                guard let place = annotation as? PlaceAnnotation,
                      placeIds.contains(place.pin.id), place.isFootprint else { return nil }
                return place
            }
            guard !targets.isEmpty else { return }
            let latitudes = targets.map(\.coordinate.latitude)
            let longitudes = targets.map(\.coordinate.longitude)
            let latitudeRange = (latitudes.max() ?? 0) - (latitudes.min() ?? 0)
            let longitudeRange = (longitudes.max() ?? 0) - (longitudes.min() ?? 0)

            // 多个地点可能因地点库去重/迁移暂时共用坐标。此时包围盒面积为零，
            // 交给 setVisibleMapRect 会放大到街道甚至建筑级；统一按单点的城市级视野处理。
            if latitudeRange < 0.01, longitudeRange < 0.01 {
                let center = CLLocationCoordinate2D(
                    latitude: latitudes.reduce(0, +) / Double(latitudes.count),
                    longitude: longitudes.reduce(0, +) / Double(longitudes.count))
                map.setRegion(MKCoordinateRegion(
                    center: center,
                    span: MKCoordinateSpan(latitudeDelta: 0.8, longitudeDelta: 0.8)), animated: animated)
                return
            }

            var rect = MKMapRect.null
            for target in targets {
                let point = MKMapPoint(target.coordinate)
                // 1×1 map point 避免所有目标恰好同纬度或同经度时产生零宽/零高包围盒。
                rect = rect.union(MKMapRect(x: point.x - 0.5, y: point.y - 0.5, width: 1, height: 1))
            }
            map.setVisibleMapRect(
                rect,
                edgePadding: UIEdgeInsets(top: 150, left: 72, bottom: 104, right: 72),
                animated: animated)
        }

        func mapView(_ mapView: MKMapView, viewFor annotation: MKAnnotation) -> MKAnnotationView? {
            if let cluster = annotation as? MKClusterAnnotation {
                let v = mapView.dequeueReusableAnnotationView(
                    withIdentifier: MKMapViewDefaultClusterAnnotationViewReuseIdentifier,
                    for: annotation) as! MKMarkerAnnotationView
                let isFootprint = (cluster.memberAnnotations.first as? PlaceAnnotation)?.isFootprint ?? false
                v.markerTintColor = isFootprint ? .systemOrange : .systemTeal
                return v
            }
            guard let pa = annotation as? PlaceAnnotation else { return nil }
            let v = mapView.dequeueReusableAnnotationView(
                withIdentifier: MKMapViewDefaultAnnotationViewReuseIdentifier,
                for: annotation) as! MKMarkerAnnotationView
            v.clusteringIdentifier = pa.isFootprint ? "footprint" : "place"
            v.markerTintColor = pa.isFootprint ? .systemOrange : .systemTeal
            v.glyphText = pa.isFootprint ? "行" : "知"
            v.displayPriority = .defaultHigh
            v.accessibilityLabel = pa.isFootprint ? "\(pa.pin.name)，我的足迹" : "\(pa.pin.name)，风物地点"
            v.accessibilityHint = "打开地点详情"
            return v
        }

        func mapView(_ mapView: MKMapView, didSelect view: MKAnnotationView) {
            if let cluster = view.annotation as? MKClusterAnnotation {
                mapView.showAnnotations(cluster.memberAnnotations, animated: true)
                mapView.deselectAnnotation(cluster, animated: false)
                return
            }
            if let pa = view.annotation as? PlaceAnnotation {
                mapView.deselectAnnotation(pa, animated: false) // 允许再次点击
                parent.onSelect(pa.pin)
            }
        }
    }
}
