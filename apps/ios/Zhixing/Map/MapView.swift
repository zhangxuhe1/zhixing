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

        func mapView(_ mapView: MKMapView, viewFor annotation: MKAnnotation) -> MKAnnotationView? {
            if annotation is MKClusterAnnotation {
                let v = mapView.dequeueReusableAnnotationView(
                    withIdentifier: MKMapViewDefaultClusterAnnotationViewReuseIdentifier,
                    for: annotation) as! MKMarkerAnnotationView
                v.markerTintColor = .systemTeal
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
