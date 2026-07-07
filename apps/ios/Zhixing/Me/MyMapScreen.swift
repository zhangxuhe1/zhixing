import SwiftUI

struct MyMapScreen: View {
    @Environment(FootprintStore.self) private var store
    @State private var pins: [Pin] = []
    @State private var flyTo: Pin?

    var body: some View {
        MapView(pins: pins, litPlaceIds: store.litPlaceIds,
                showHumanities: false, showFootprints: true,
                flyTo: $flyTo, onSelect: { _ in })
            .ignoresSafeArea(edges: .bottom)
            .navigationTitle("我的足迹地图")
            .navigationBarTitleDisplayMode(.inline)
            .task {
                pins = (try? await APIClient.shared.get("/places/pins")) ?? []
            }
    }
}
