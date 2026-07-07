import SwiftUI

struct SearchSheet: View {
    var prompt = "搜地名，直达那里"
    var onPick: (Pin) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var results: [Pin] = []
    @State private var searched = false

    var body: some View {
        NavigationStack {
            List {
                ForEach(results) { pin in
                    Button { onPick(pin) } label: {
                        HStack {
                            Text(pin.name)
                            Spacer()
                            Text(pin.cardCount > 0 ? "\(pin.cardCount) 张风物卡" : "暂无内容")
                                .font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .foregroundStyle(.primary)
                }
                if searched && results.isEmpty {
                    Text("没找到「\(query)」——已记下，会尽快补上这里的风物")
                        .foregroundStyle(.secondary)
                }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always),
                        prompt: prompt)
            .onSubmit(of: .search) { Task { await search() } }
            .navigationTitle("搜索")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
            }
        }
    }

    private func search() async {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty,
              let q = trimmed.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)
        else { return }
        results = (try? await APIClient.shared.get("/search?q=\(q)")) ?? []
        searched = true
    }
}
