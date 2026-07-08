import SwiftUI

struct PlaceDrawer: View {
    let pin: Pin
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
            VStack(spacing: 0) {
                Picker("显示分段", selection: $section) {
                    ForEach(DrawerSection.allCases, id: \.self) { item in
                        Text(item.rawValue).tag(item)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal)
                .padding(.top, 8)
                .padding(.bottom, 4)

                switch section {
                case .cards:
                    cardsContent
                case .stories:
                    StoriesSection(placeId: pin.id, onComposeFootprint: { showComposer = true })
                case .photos:
                    PhotoWallSection(placeId: pin.id)
                }
            }
            .navigationTitle(pin.name)
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: Card.self) { CardDetailView(card: $0) }
            .toolbar {
                ToolbarItem(placement: .bottomBar) {
                    Button { showComposer = true } label: {
                        Label("在此留足迹", systemImage: "shoeprints.fill")
                    }
                }
            }
            .sheet(isPresented: $showComposer) { FootprintComposer(pin: pin) }
        }
        .presentationDetents([.medium, .large])
        .presentationBackgroundInteraction(.enabled(upThrough: .medium))
        .task { await loadCards() }
    }

    private var cardsContent: some View {
        LoadStateView(state: cardsState, retry: { Task { await loadCards() } }) { cards in
            List {
                if cards.isEmpty {
                    Text("这里还没有风物卡，搜索或报错会帮我们知道该补哪儿")
                        .foregroundStyle(.secondary)
                }
                ForEach(cards) { card in
                    NavigationLink(value: card) {
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(spacing: 6) {
                                Text(card.categoryLabel)
                                    .font(.caption)
                                    .padding(.horizontal, 7).padding(.vertical, 2)
                                    .background(.teal.opacity(0.15), in: Capsule())
                                if card.isAIGenerated {
                                    Text("AI 整理·待复核")
                                        .font(.caption2).foregroundStyle(.orange)
                                }
                            }
                            Text(card.title).font(.headline)
                        }
                        .padding(.vertical, 2)
                    }
                }
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
