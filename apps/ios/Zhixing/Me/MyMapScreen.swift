import SwiftUI

struct MyMapScreen: View {
    @Environment(FootprintStore.self) private var store
    @State private var pinsState: LoadState<[Pin]> = .idle
    @State private var flyTo: Pin?

    var body: some View {
        LoadStateView(state: pinsState, retry: { Task { await loadPins() } }) { pins in
            MapView(pins: pins, litPlaceIds: store.litPlaceIds,
                    showHumanities: false, showFootprints: true,
                    flyTo: $flyTo, onSelect: { _ in })
        }
        .ignoresSafeArea(edges: .bottom)
        .navigationTitle("我的足迹地图")
        .navigationBarTitleDisplayMode(.inline)
        .task { await loadPins() }
    }

    private func loadPins() async {
        pinsState = .loading
        do {
            let pins: [Pin] = try await APIClient.shared.get("/places/pins")
            pinsState = .loaded(pins)
        } catch {
            pinsState = .failed("加载地图数据失败，请重试")
        }
    }
}
