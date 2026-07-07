import SwiftUI

struct MapScreen: View {
    @State private var pins: [Pin] = []
    @State private var selected: Pin?
    @State private var flyTo: Pin?
    @State private var loadError: String?

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            MapView(pins: pins, litPlaceIds: [], showHumanities: true, showFootprints: false,
                    flyTo: $flyTo, onSelect: { selected = $0 })
                .ignoresSafeArea()
            if let loadError {
                Text(loadError).font(.footnote).foregroundStyle(.red)
                    .padding(8).background(.thinMaterial).padding()
            }
        }
        .task { await load() }
        .sheet(item: $selected) { pin in
            PlaceDrawer(pin: pin)
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
