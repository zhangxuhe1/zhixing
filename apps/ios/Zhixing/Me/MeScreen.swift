import SwiftUI

struct MeScreen: View {
    @Environment(SessionStore.self) private var session
    @Environment(FootprintStore.self) private var store
    @State private var showImport = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    statsRow
                    NavigationLink("我的足迹地图") { MyMapScreen() }
                }
                Section("足迹") {
                    if store.footprints.isEmpty {
                        Text("还没有足迹——去地图上留一个，或从相册导入过去的旅行")
                            .foregroundStyle(.secondary)
                    }
                    ForEach(store.footprints) { fp in
                        FootprintRow(footprint: fp)
                    }
                    .onDelete { indexSet in
                        let targets = indexSet.map { store.footprints[$0] } // 删除前按索引快照，避免边删边移位
                        Task {
                            for footprint in targets { await store.delete(footprint) }
                        }
                    }
                }
                Section {
                    Button { showImport = true } label: {
                        Label("从相册批量导入", systemImage: "photo.stack")
                    }
                }
                Section {
                    Button("退出登录", role: .destructive) { session.signOut() }
                }
            }
            .navigationTitle(session.user?.nickname ?? "我的")
            .sheet(isPresented: $showImport) { AlbumImportScreen() }
            .task { await store.load() }
        }
    }

    private var statsRow: some View {
        HStack {
            statCell(store.stats?.footprints, "足迹")
            statCell(store.stats?.places, "地点")
            statCell(store.stats?.cities, "城市")
            statCell(store.stats?.provinces, "省份")
        }
        .padding(.vertical, 6)
    }

    private func statCell(_ value: Int?, _ label: String) -> some View {
        VStack(spacing: 2) {
            Text("\(value ?? 0)").font(.title2.bold())
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }
}

struct FootprintRow: View {
    let footprint: Footprint

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(footprint.place.name).font(.headline)
                Spacer()
                Text(footprint.date, format: .dateTime.year().month().day())
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let text = footprint.text, !text.isEmpty {
                Text(text).font(.subheadline).lineLimit(2)
            }
            if !footprint.photos.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(footprint.photos) { photo in
                            AuthedPhotoView(photoId: photo.id)
                                .frame(width: 72, height: 72)
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }
}
