import SwiftUI

struct MapScreen: View {
    @Environment(FootprintStore.self) private var footprints
    @State private var pins: [Pin] = []
    @State private var selected: Pin?
    @State private var flyTo: Pin?
    @State private var showSearch = false
    @State private var loadError: String?
    @State private var showPlacePicker = false
    @State private var composerPin: Pin?
    @State private var showHumanities = true
    @State private var showFootprintLayer = true

    var body: some View {
        ZStack(alignment: .trailing) {
            MapView(pins: pins, litPlaceIds: footprints.litPlaceIds,
                    showHumanities: showHumanities, showFootprints: showFootprintLayer,
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
        .task {
            await load()
            await footprints.load()
        }
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
                    do {
                        let pin: Pin = try await APIClient.shared.get("/places/random")
                        loadError = nil
                        goTo(pin)
                    } catch {
                        loadError = "随机地点加载失败，请重试"
                    }
                }
            }
            Menu {
                Toggle("人文层（知）", isOn: $showHumanities)
                Toggle("足迹层（行）", isOn: $showFootprintLayer)
            } label: {
                Image(systemName: "square.3.layers.3d")
                    .font(.system(size: 17, weight: .semibold))
                    .frame(width: 44, height: 44)
                    .background(.thinMaterial, in: Circle())
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
