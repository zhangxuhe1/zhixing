import SwiftUI

struct MapScreen: View {
    @State private var pins: [Pin] = []
    @State private var selected: Pin?
    @State private var flyTo: Pin?
    @State private var showSearch = false
    @State private var loadError: String?
    @State private var showPlacePicker = false
    @State private var composerPin: Pin?

    var body: some View {
        ZStack(alignment: .trailing) {
            MapView(pins: pins, litPlaceIds: [], showHumanities: true, showFootprints: false,
                    flyTo: $flyTo, onSelect: { selected = $0 })
                .ignoresSafeArea()
            controls.padding(.trailing, 12)
        }
        .overlay(alignment: .bottom) {
            if let loadError {
                Text(loadError)
                    .font(.footnote).foregroundStyle(.red)
                    .padding(8).background(.thinMaterial, in: RoundedRectangle(cornerRadius: 8))
                    .padding(.bottom, 24)
            }
        }
        .task { await load() }
        .sheet(item: $selected) { pin in
            PlaceDrawer(pin: pin)
        }
        .sheet(isPresented: $showSearch) {
            SearchSheet { pin in
                showSearch = false
                goTo(pin)
            }
        }
        .sheet(isPresented: $showPlacePicker) {
            SearchSheet(prompt: "搜地点，在那里留足迹") { pin in
                showPlacePicker = false
                composerPin = pin
            }
        }
        .sheet(item: $composerPin) { pin in
            FootprintComposer(pin: pin)
        }
    }

    private var controls: some View {
        VStack(spacing: 14) {
            controlButton("magnifyingglass") { showSearch = true }
            controlButton("shuffle") {
                Task {
                    if let pin: Pin = try? await APIClient.shared.get("/places/random") {
                        goTo(pin)
                    }
                }
            }
            controlButton("plus") { showPlacePicker = true }
        }
    }

    private func controlButton(_ icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 17, weight: .semibold))
                .frame(width: 44, height: 44)
                .background(.thinMaterial, in: Circle())
        }
    }

    private func goTo(_ pin: Pin) {
        flyTo = pin
        // 等飞行动画起步再开抽屉，medium 态不遮住目的地
        Task {
            try? await Task.sleep(for: .milliseconds(600))
            selected = pin
        }
    }

    private func load() async {
        do {
            pins = try await APIClient.shared.get("/places/pins")
        } catch {
            loadError = "加载地点失败：\(error.localizedDescription)"
        }
    }
}
