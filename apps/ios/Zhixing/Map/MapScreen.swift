import PhotosUI
import SwiftUI

struct MapScreen: View {
    @Environment(FootprintStore.self) private var footprints
    @Environment(PinsCache.self) private var pinsCache
    @State private var selected: Pin?
    @State private var flyTo: Pin?
    @State private var fitPlaceIds: Set<String>?
    @State private var showSearch = false
    @State private var loadError: String?
    @State private var showPlacePicker = false
    @State private var composerPin: Pin?
    @State private var pendingComposerPin: Pin?
    #if targetEnvironment(macCatalyst)
    @State private var composerDraftPin: Pin?
    @State private var composerText = ""
    @State private var composerDate = Date()
    @State private var composerPhotoItems: [PhotosPickerItem] = []
    @State private var composerIsPublic = false
    @State private var composerError: String?
    @State private var composerCreatedFootprint: Footprint?
    @State private var showComposerPhotoPicker = false
    @State private var restoreComposerAfterPhotoPicker = false
    #endif
    @State private var showHumanities = true
    @State private var showFootprintLayer = true
    @State private var flightTask: Task<Void, Never>?
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    var body: some View {
        ZStack(alignment: .topTrailing) {
            MapView(pins: pinsCache.pins, litPlaceIds: footprints.litPlaceIds,
                    showHumanities: showHumanities, showFootprints: showFootprintLayer,
                    flyTo: $flyTo, fitPlaceIds: $fitPlaceIds,
                    onSelect: { selected = $0 })
                .ignoresSafeArea()
            controls
                .padding(.top, 16)
                .padding(.trailing, 16)
        }
        .overlay(alignment: .bottomLeading) {
            layerLegend
                .padding(.leading, 16)
                .padding(.bottom, 18)
        }
        .overlay(alignment: .bottom) {
            if let loadError {
                ZXErrorBanner(message: loadError)
                    .padding(.bottom, 24)
            }
        }
        .task {
            await load()
            await footprints.load()
        }
        .sheet(item: $selected, onDismiss: presentPendingComposer) { pin in
            PlaceDrawer(pin: pin) {
                // Catalyst 上不能从 PlaceDrawer 的小 form sheet 继续嵌套撰写器；
                // 先关闭抽屉，再由地图根层呈现，PhotosUI 才能拿到整个窗口的可用空间。
                pendingComposerPin = pin
                selected = nil
            }
            .appStores()
        }
        .sheet(isPresented: $showSearch) {
            SearchSheet { pin in
                showSearch = false
                goTo(pin)
            }
            .appStores()
        }
        .sheet(isPresented: $showPlacePicker, onDismiss: presentPendingComposer) {
            PlacePickerSheet(pins: pinsCache.pins) { pin in
                pendingComposerPin = pin
                showPlacePicker = false
            }
            .appStores()
        }
        .sheet(item: $composerPin, onDismiss: handleComposerDismissed) { pin in
            #if targetEnvironment(macCatalyst)
            FootprintComposer(
                pin: pin,
                text: $composerText,
                date: $composerDate,
                items: $composerPhotoItems,
                isPublic: $composerIsPublic,
                error: $composerError,
                createdFootprint: $composerCreatedFootprint,
                onChoosePhotos: requestComposerPhotoPicker
            )
                .appStores()
            #else
            FootprintComposer(pin: pin)
                .appStores()
            #endif
        }
        #if targetEnvironment(macCatalyst)
        // 选择器挂在地图根层，而不是撰写器的小 sheet 内；PhotosUI 因而能使用完整窗口，
        // 同时不会迫使 FootprintComposer 本身改成全屏。
        .photosPicker(
            isPresented: $showComposerPhotoPicker,
            selection: $composerPhotoItems,
            maxSelectionCount: ZXLimit.footprintPhotos,
            selectionBehavior: .ordered,
            matching: .images
        )
        .photosPickerStyle(.presentation)
        .onChange(of: showComposerPhotoPicker) { wasPresented, isPresented in
            guard wasPresented, !isPresented,
                  restoreComposerAfterPhotoPicker,
                  let pin = composerDraftPin
            else { return }
            restoreComposerAfterPhotoPicker = false
            composerPin = pin
        }
        #endif
    }

    private func presentPendingComposer() {
        guard composerPin == nil, let pin = pendingComposerPin else { return }
        pendingComposerPin = nil
        #if targetEnvironment(macCatalyst)
        beginComposerDraft(for: pin)
        #endif
        composerPin = pin
    }

    private func handleComposerDismissed() {
        #if targetEnvironment(macCatalyst)
        if restoreComposerAfterPhotoPicker {
            // PhotosPicker 与普通 sheet 不能同时由同一根视图可靠呈现；等待小窗完全收起后再开图库。
            showComposerPhotoPicker = true
        } else {
            resetComposerDraft()
        }
        #endif
    }

    #if targetEnvironment(macCatalyst)
    private func requestComposerPhotoPicker() {
        guard composerDraftPin != nil, !showComposerPhotoPicker else { return }
        restoreComposerAfterPhotoPicker = true
        composerPin = nil
    }

    private func beginComposerDraft(for pin: Pin) {
        composerDraftPin = pin
        composerText = ""
        composerDate = Date()
        composerPhotoItems = []
        composerIsPublic = false
        composerError = nil
        composerCreatedFootprint = nil
        showComposerPhotoPicker = false
        restoreComposerAfterPhotoPicker = false
    }

    private func resetComposerDraft() {
        composerDraftPin = nil
        composerText = ""
        composerDate = Date()
        composerPhotoItems = []
        composerIsPublic = false
        composerError = nil
        composerCreatedFootprint = nil
        showComposerPhotoPicker = false
        restoreComposerAfterPhotoPicker = false
    }
    #endif

    private var controls: some View {
        Group {
            if horizontalSizeClass == .regular {
                HStack(spacing: 4) { controlItems }
            } else {
                VStack(spacing: 4) { controlItems }
            }
        }
        .padding(6)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(Color.white.opacity(0.50), lineWidth: 1)
        }
        .shadow(color: ZXTheme.ink.opacity(0.16), radius: 18, y: 8)
    }

    @ViewBuilder
    private var controlItems: some View {
        controlButton("magnifyingglass", title: "搜索地点") { showSearch = true }
        controlButton("shuffle", title: "随便走走") {
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
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(ZXTheme.pine)
                .frame(width: 42, height: 42)
                .contentShape(Rectangle())
        }
        .accessibilityLabel("地图图层")
        .help("地图图层")
        controlButton("plus", title: "留下足迹", emphasized: true) { showPlacePicker = true }
    }

    private func controlButton(
        _ icon: String,
        title: String,
        emphasized: Bool = false,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(emphasized ? .white : ZXTheme.pine)
                .frame(width: 42, height: 42)
                .background(emphasized ? ZXTheme.cinnabar : Color.clear, in: RoundedRectangle(cornerRadius: 12))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .help(title)
    }

    private var layerLegend: some View {
        HStack(spacing: 12) {
            if showHumanities {
                legendItem(color: ZXTheme.pine, text: "风物")
            }
            if showFootprintLayer {
                legendItem(color: ZXTheme.cinnabar, text: "足迹")
            }
        }
        .font(.caption.weight(.medium))
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(.ultraThinMaterial, in: Capsule())
        .overlay { Capsule().stroke(Color.white.opacity(0.45), lineWidth: 1) }
        .shadow(color: ZXTheme.ink.opacity(0.12), radius: 12, y: 6)
    }

    private func legendItem(color: Color, text: String) -> some View {
        HStack(spacing: 6) {
            Circle().fill(color).frame(width: 8, height: 8)
            Text(text)
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
                Text("快速选点")
                    .font(.headline)
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
                .buttonStyle(ZXSecondaryButtonStyle())
                if let hint {
                    Text(hint)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(20)
            .background(ZXTheme.canvas)
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
            // Core Location 给的是 WGS-84,pin 是 GCJ-02:匹配前先转,否则系统性偏 100-700m
            let q = wgs2gcj(lat: coordinate.latitude, lng: coordinate.longitude)
            if let pin = nearestPin(lat: q.lat, lng: q.lng, pins: pins) {
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
