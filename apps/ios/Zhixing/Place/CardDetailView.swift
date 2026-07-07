import SwiftUI

struct CardDetailView: View {
    let card: Card

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 8) {
                    Text(card.categoryLabel)
                        .font(.caption)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(.teal.opacity(0.15), in: Capsule())
                    if card.isAIGenerated {
                        Label("AI 整理·待复核", systemImage: "sparkles")
                            .font(.caption).foregroundStyle(.orange)
                    }
                }
                Text(card.title).font(.title2.bold())
                ForEach(card.blocks) { block in
                    if block.type == "TEXT", let text = block.text {
                        Text(text).font(.body).lineSpacing(7)
                    }
                }
                DisclosureGroup {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(card.sources, id: \.self) { source in
                            Text("· \(source)").font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.top, 6)
                } label: {
                    Text("参考来源").font(.subheadline)
                }
            }
            .padding(20)
        }
        .navigationBarTitleDisplayMode(.inline)
    }
}
