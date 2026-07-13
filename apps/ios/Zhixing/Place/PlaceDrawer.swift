import SwiftUI

struct PlaceDrawer: View {
    let pin: Pin
    @Environment(\.dismiss) private var dismiss
    @State private var cardsState: LoadState<[Card]> = .idle
    @State private var showComposer = false
    @State private var section: DrawerSection = .cards

    /// 三段式 tab：风物卡（M1 落地）/ 旅人故事（I4）/ 旅人镜头（本任务，I5）。
    private enum DrawerSection: String, CaseIterable, Hashable {
        case cards = "风物卡"
        case stories = "旅人故事"
        case photos = "旅人镜头"
    }

    var body: some View {
        NavigationStack {
            ZStack {
                ZXTheme.canvas.ignoresSafeArea()
                LinearGradient(
                    colors: [ZXTheme.rice.opacity(0.48), .clear],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing)
                    .ignoresSafeArea()

                VStack(spacing: 0) {
                    HStack(spacing: 14) {
                        Image(systemName: "mappin.and.ellipse")
                            .font(.system(size: 20, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(width: 44, height: 44)
                            .background(ZXTheme.pine, in: RoundedRectangle(cornerRadius: 13))
                        VStack(alignment: .leading, spacing: 2) {
                            Text("在地故事")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(ZXTheme.cinnabar)
                            Text(pin.name)
                                .font(.system(.title2, design: .serif, weight: .bold))
                        }
                        Spacer()
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 14)
                    .padding(.bottom, 12)

                    Picker("显示分段", selection: $section) {
                        ForEach(DrawerSection.allCases, id: \.self) { item in
                            Text(item.rawValue).tag(item)
                        }
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal, 20)
                    .padding(.bottom, 10)

                    sectionContent
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            }
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: Card.self) { CardDetailView(card: $0) }
            .toolbar {
                // Mac Catalyst：抽屉是以 sheet 弹出的浮层，Mac 上没有 iOS 的下滑关闭手势、只能按 ESC；
                // 补一个显式「关闭」把抽屉收回地图。iOS 不加：detent + 下滑关闭已是原生约定，加了反而多余。
                // 位置/写法对齐旅人故事详情（StoryDetailView）的 .cancellationAction「关闭」。
                #if targetEnvironment(macCatalyst)
                ToolbarItem(placement: .cancellationAction) {
                    Button("关闭") { dismiss() }
                }
                #endif
            }
            .sheet(isPresented: $showComposer) { FootprintComposer(pin: pin).appStores() }
        }
        .presentationDetents([.medium, .large])
        .presentationBackgroundInteraction(.enabled(upThrough: .medium))
        .safeAreaInset(edge: .bottom) {
            Button { showComposer = true } label: {
                Label("在此留足迹", systemImage: "shoeprints.fill")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(ZXPrimaryButtonStyle())
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .background(.ultraThinMaterial)
        }
        .task { await loadCards() }
    }

    @ViewBuilder
    private var sectionContent: some View {
        switch section {
        case .cards:
            cardsContent
        case .stories:
            StoriesSection(placeId: pin.id, onComposeFootprint: { showComposer = true })
        case .photos:
            PhotoWallSection(placeId: pin.id, onComposeFootprint: { showComposer = true })
        }
    }

    private var cardsContent: some View {
        LoadStateView(state: cardsState, retry: { Task { await loadCards() } }) { cards in
            ScrollView {
                LazyVStack(spacing: 10) {
                if cards.isEmpty {
                    ZXSectionEmptyState(
                        icon: "text.book.closed",
                        eyebrow: "风物卡",
                        title: "这里的故事还在路上",
                        message: "搜索与访问会帮助我们知道，下一张风物卡该补在哪里。")
                }
                ForEach(cards) { card in
                    NavigationLink(value: card) {
                        HStack(spacing: 14) {
                            VStack(alignment: .leading, spacing: 9) {
                                HStack(spacing: 7) {
                                    ZXCategoryBadge(text: card.categoryLabel)
                                    if card.isAIGenerated {
                                            Label("待复核", systemImage: "sparkles")
                                                .font(.caption2)
                                                .foregroundStyle(ZXTheme.oldGold)
                                    }
                                }
                                Text(card.title)
                                    .font(.headline)
                                    .foregroundStyle(.primary)
                                    .multilineTextAlignment(.leading)
                            }
                            Spacer(minLength: 8)
                            Image(systemName: "chevron.right")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.tertiary)
                        }
                        .zxSurface(radius: 17, padding: 16)
                    }
                    .buttonStyle(.plain)
                }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
            }
        }
    }

    private func loadCards() async {
        cardsState = .loading
        do {
            let cards: [Card] = try await APIClient.shared.get("/places/\(pin.id)/cards")
            cardsState = .loaded(cards)
        } catch {
            cardsState = .failed("风物卡加载失败，请重试")
        }
    }
}
