import SwiftUI

struct MyMapScreen: View {
    @Environment(FootprintStore.self) private var store
    @Environment(PinsCache.self) private var pinsCache
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
            try await pinsCache.load() // 命中缓存（MapScreen 已经拉过）时不重发网络请求
            pinsState = .loaded(pinsCache.pins)
        } catch {
            pinsState = .failed("加载地图数据失败，请重试")
        }
    }
}
