import SwiftUI

struct MapScreen: View {
    @Environment(FootprintStore.self) private var footprints
    @Environment(PinsCache.self) private var pinsCache
    @State private var selected: Pin?
    @State private var flyTo: Pin?
    @State private var showSearch = false
    @State private var loadError: String?
    @State private var showPlacePicker = false
    @State private var composerPin: Pin?
    @State private var showHumanities = true
    @State private var showFootprintLayer = true
    @State private var flightTask: Task<Void, Never>?

    var body: some View {
        ZStack(alignment: .trailing) {
            MapView(pins: pinsCache.pins, litPlaceIds: footprints.litPlaceIds,
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
            PlacePickerSheet(pins: pinsCache.pins) { pin in
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

    /// 连点竞态修复：新的 goTo 先取消上一个还在等待的飞行任务，被取消的任务绝不能在延时结束后
    /// 还去开抽屉——否则快速点两个不同的搜索结果，最终可能弹出的是第一个（旧）而不是第二个（新）目的地。
    private func goTo(_ pin: Pin) {
        flightTask?.cancel()
        flyTo = pin
        // 等飞行动画起步再开抽屉，medium 态不遮住目的地
        flightTask = Task {
            try? await Task.sleep(for: .milliseconds(600))
            guard !Task.isCancelled else { return }
            selected = pin
        }
    }

    private func load() async {
        do {
            try await pinsCache.load()
        } catch {
            loadError = "加载地点失败：\(error.localizedDescription)"
        }
    }
}

/// ［+］选点 sheet：顶部「使用当前位置」一键命中最近地点，其下沿用既有搜索选点不变。
private struct PlacePickerSheet: View {
    let pins: [Pin]
    var onPick: (Pin) -> Void

    @State private var locating = false
    @State private var hint: String?

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                Button {
                    Task { await useCurrentLocation() }
                } label: {
                    HStack(spacing: 8) {
                        if locating {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "location.fill")
                        }
                        Text("使用当前位置")
                        Spacer()
                    }
                }
                .disabled(locating)
                if let hint {
                    Text(hint)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .padding()
            Divider()
            SearchSheet(prompt: "搜地点，在那里留足迹", onPick: onPick)
        }
    }

    private func useCurrentLocation() async {
        locating = true
        hint = nil
        defer { locating = false }
        do {
            let coordinate = try await LocationOnce.current()
            if let pin = nearestPin(lat: coordinate.latitude, lng: coordinate.longitude, pins: pins) {
                onPick(pin)
            } else {
                hint = "附近还没有收录的地点，试试搜索"
            }
        } catch LocationError.denied {
            hint = "尚未开启定位权限，请到系统设置中开启后重试"
        } catch LocationError.timeout {
            hint = "定位超时，请重试"
        } catch {
            hint = "定位失败，请重试"
        }
    }
}
