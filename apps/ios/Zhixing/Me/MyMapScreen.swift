import SwiftUI

struct MyMapScreen: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(FootprintStore.self) private var store
    @Environment(PinsCache.self) private var pinsCache
    @State private var pinsState: LoadState<[Pin]> = .idle
    @State private var flyTo: Pin?
    @State private var fitPlaceIds: Set<String>?
    @State private var selectedPin: Pin?
    @State private var showImport = false

    /// 与故事地图对齐：地图满铺；仅多一块顶部「我的足迹」统计，无导航栏材质遮罩。
    private var showsSummaryChrome: Bool {
        pinsState.value != nil && !store.footprints.isEmpty
    }

    /// iPhone 的 compact 导航栏要给返回按钮和页面标题留出稳定空间；
    /// 四列统计只在 regular/Catalyst 的宽顶栏中展开，窄屏回落到地图内的纵向卡片。
    private var summaryPlacement: MyMapSummaryPlacement {
        .resolve(horizontalSizeClass: horizontalSizeClass)
    }

    private var navigationBarVisibility: Visibility {
        summaryPlacement == .toolbar ? .hidden : .visible
    }

    var body: some View {
        ZStack {
            LoadStateView(state: pinsState, retry: { Task { await loadPins(force: true) } }) { pins in
                MapView(pins: pins, litPlaceIds: store.litPlaceIds,
                        showHumanities: false, showFootprints: true,
                        flyTo: $flyTo, fitPlaceIds: $fitPlaceIds,
                        onSelect: { selectedPin = $0 })
                    // 与故事地图一致满铺，减少实色 chrome 把侧栏材质吸成死黑
                    .ignoresSafeArea()
                    .accessibilityLabel("我的足迹地图")
            }

            if pinsState.value != nil {
                mapOverlays
            }
        }
        // idle 对应 EmptyView，MapView 本身也没有固有尺寸；必须由稳定的满屏容器承接，
        // 否则 Catalyst 的 NavigationSplitView → NavigationStack 目标页会整体坍缩成零尺寸。
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(ZXTheme.canvas)
        .navigationTitle("我的足迹地图")
        .navigationBarTitleDisplayMode(.inline)
        // 宽屏取消顶栏材质，让地图透上来；compact 保留系统导航底，确保返回按钮稳定可见。
        .toolbarBackground(navigationBarVisibility, for: .navigationBar)
        .toolbar {
            if showsSummaryChrome && summaryPlacement == .toolbar {
                ToolbarItem(placement: .principal) {
                    MyMapSummaryCard(
                        stats: store.stats,
                        footprints: store.footprints,
                        layout: .toolbar)
                }
            }
        }
        .task {
            // 先让地图尽快出现，再刷新本人数据。用户可能刚从地图页新增过足迹，
            // FootprintStore 的 stats 仍是上一次快照；进入个人地图时主动收敛到服务端最新状态。
            await loadPins()
            await store.load()
        }
        .onChange(of: store.litPlaceIds) { _, ids in
            guard !ids.isEmpty else { return }
            fitPlaceIds = ids
        }
        .sheet(item: $selectedPin) { pin in
            FootprintPlaceSheet(pin: pin)
                .appStores()
                .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $showImport) {
            AlbumImportScreen().appStores()
        }
    }

    @ViewBuilder
    private var mapOverlays: some View {
        if store.footprints.isEmpty {
            emptyState
        } else {
            // regular/Catalyst 的统计在 toolbar；compact 使用可纵向扩展的地图内卡片，
            // 避免四列统计与返回按钮争抢 iPhone 导航栏宽度。
            VStack(spacing: 0) {
                if summaryPlacement == .overlay {
                    MyMapSummaryCard(
                        stats: store.stats,
                        footprints: store.footprints,
                        layout: .overlay)
                }
                Spacer()
                HStack(alignment: .bottom) {
                    Label("已点亮 \(store.litPlaceIds.count) 个地方", systemImage: "mappin.and.ellipse")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(ZXTheme.accent)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 9)
                        .background(.ultraThinMaterial, in: Capsule())
                        .overlay { Capsule().stroke(Color.white.opacity(0.48), lineWidth: 1) }
                    Spacer()
                    Button { fitPlaceIds = store.litPlaceIds } label: {
                        Image(systemName: "scope")
                            .font(.system(size: 17, weight: .semibold))
                            .frame(width: 44, height: 44)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(ZXTheme.accent)
                    .background(.ultraThinMaterial, in: Circle())
                    .overlay { Circle().stroke(Color.white.opacity(0.48), lineWidth: 1) }
                    .shadow(color: ZXTheme.ink.opacity(0.14), radius: 12, y: 5)
                    .accessibilityLabel("显示全部足迹")
                    .help("显示全部足迹")
                }
            }
            .padding(16)
            .allowsHitTesting(true)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 18) {
            ZXEmptyState(
                icon: "map.fill",
                title: "地图还在等你的第一段足迹",
                message: "从相册导入过去的旅行，或回到故事地图留下一段故事。")
            Button { showImport = true } label: {
                Label("从相册点亮过去的旅行", systemImage: "photo.stack.fill")
            }
            .buttonStyle(ZXPrimaryButtonStyle())
            Button("返回我的知行") { dismiss() }
                .buttonStyle(ZXSecondaryButtonStyle())
        }
        .padding(24)
        .frame(maxWidth: 460)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(Color.white.opacity(0.48), lineWidth: 1)
        }
        .shadow(color: ZXTheme.ink.opacity(0.15), radius: 24, y: 10)
        .padding(24)
    }

    private func loadPins(force: Bool = false) async {
        pinsState = .loading
        do {
            try await pinsCache.load(force: force) // 命中缓存（MapScreen 已经拉过）时不重发网络请求
            pinsState = .loaded(pinsCache.pins)
            if !store.litPlaceIds.isEmpty {
                fitPlaceIds = store.litPlaceIds
            }
        } catch {
            pinsState = .failed("加载地图数据失败，请重试")
        }
    }
}

enum MyMapSummaryPlacement: Equatable {
    case toolbar
    case overlay

    static func resolve(horizontalSizeClass: UserInterfaceSizeClass?) -> Self {
        horizontalSizeClass == .compact ? .overlay : .toolbar
    }
}

struct MyMapSummaryCard: View {
    enum Layout {
        case toolbar
        case overlay
    }

    let stats: Stats?
    let footprints: [Footprint]
    let layout: Layout

    private var placeCount: Int { Set(footprints.map(\.placeId)).count }

    /// 足迹和地点可以由当前列表精确计算；城市/省份依赖服务端层级统计。
    /// 如果 stats 与列表不是同一版本，宁可暂时显示占位，也不展示彼此矛盾的数字。
    private var currentHierarchyStats: Stats? {
        guard stats?.footprints == footprints.count, stats?.places == placeCount else { return nil }
        return stats
    }

    var body: some View {
        Group {
            switch layout {
            case .toolbar:
                toolbarLayout
            case .overlay:
                overlayLayout
            }
        }
        .accessibilityElement(children: .contain)
    }

    /// regular/Catalyst：宽顶栏允许标题与四列统计横排。
    private var toolbarLayout: some View {
        HStack(spacing: 12) {
            title.layoutPriority(1)

            // 标题与数字区视觉分隔，避免一整条胶囊糊成一团。
            Capsule()
                .fill(ZXTheme.ink.opacity(0.12))
                .frame(width: 1, height: 28)

            statsRow
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(minWidth: 300, maxWidth: 460)
        .background(.ultraThinMaterial, in: Capsule())
        .overlay { Capsule().stroke(Color.white.opacity(0.50), lineWidth: 1) }
        .shadow(color: ZXTheme.ink.opacity(0.12), radius: 12, y: 5)
    }

    /// iPhone compact：标题置于统计上方，宽度跟随内容区，Dynamic Type 可向下增长而不挤导航按钮。
    private var overlayLayout: some View {
        VStack(alignment: .leading, spacing: 12) {
            title
            statsRow
        }
        .padding(16)
        .frame(maxWidth: 430)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(Color.white.opacity(0.52), lineWidth: 1)
        }
        .shadow(color: ZXTheme.ink.opacity(0.14), radius: 16, y: 7)
    }

    private var title: some View {
        HStack(spacing: 8) {
            Image(systemName: "figure.walk")
                .font(.body.weight(.semibold))
                .foregroundStyle(ZXTheme.cinnabar)
                .accessibilityHidden(true)
            Text("我的足迹")
                .font(.system(.callout, design: .serif, weight: .semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.85)
        }
    }

    private var statsRow: some View {
        HStack(spacing: 0) {
            stat(footprints.count, "足迹")
            Divider().frame(height: 28)
            stat(placeCount, "地点")
            Divider().frame(height: 28)
            stat(currentHierarchyStats?.cities, "城市")
            Divider().frame(height: 28)
            stat(currentHierarchyStats?.provinces, "省份")
        }
    }

    private func stat(_ value: Int?, _ label: String) -> some View {
        VStack(spacing: 2) {
            Text(value.map(String.init) ?? "—")
                .font(.system(.body, design: .rounded, weight: .bold))
                .monospacedDigit()
                .foregroundStyle(ZXTheme.accent)
            Text(label)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
        }
        // 单列至少 52pt，配合 8pt 级间距，避免四列挤成细缝。
        .frame(minWidth: 52, maxWidth: .infinity)
        .padding(.horizontal, 4)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(label) \(value.map(String.init) ?? "尚未加载")")
    }
}

private struct FootprintPlaceSheet: View {
    let pin: Pin
    @Environment(\.dismiss) private var dismiss
    @Environment(FootprintStore.self) private var store

    private var footprints: [Footprint] {
        store.footprints.filter { $0.placeId == pin.id }
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 14) {
                        Image(systemName: "mappin.circle.fill")
                            .font(.system(size: 32))
                            .foregroundStyle(ZXTheme.cinnabar)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(pin.name)
                                .font(.system(.title3, design: .serif, weight: .bold))
                            Text("在这里留下了 \(footprints.count) 段足迹")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 6)
                }
                .listRowBackground(Color.clear)

                Section("足迹") {
                    ForEach(footprints) { footprint in
                        NavigationLink { FootprintDetailView(footprint: footprint) } label: {
                            FootprintRow(footprint: footprint)
                        }
                        .accessibilityHint("查看这段足迹")
                    }
                }
            }
            .scrollContentBackground(.hidden)
            .background(ZXTheme.canvas)
            .navigationTitle("地点足迹")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }
            }
        }
    }
}
