import SwiftUI

struct MeScreen: View {
    @Environment(SessionStore.self) private var session
    @Environment(FootprintStore.self) private var store
    @State private var showImport = false
    @State private var editingFootprint: Footprint?
    @State private var deleteError: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    profileHeader
                    statsRow
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))

                Section("我的知行") {
                    NavigationLink { MyMapScreen() } label: {
                        destinationRow(
                            icon: "map.fill", title: "我的足迹地图",
                            subtitle: "看看被你点亮的城市与地方")
                    }
                    NavigationLink { FavoritesScreen() } label: {
                        destinationRow(
                            icon: "bookmark.fill", title: "行前收藏",
                            subtitle: "把想读的风物整理成一份功课")
                    }
                    NavigationLink { TripsScreen() } label: {
                        destinationRow(
                            icon: "map.circle.fill", title: "旅程小结",
                            subtitle: "把一段行程整理成可分享的故事")
                    }
                }

                Section("最近足迹") {
                    if store.footprints.isEmpty {
                        ZXEmptyState(
                            icon: "shoeprints.fill",
                            title: "地图还在等你的第一段足迹",
                            message: "去地图上留下一段故事，或从相册导入过去的旅行。")
                            .frame(maxWidth: .infinity)
                            .listRowBackground(Color.clear)
                    }
                    ForEach(store.footprints) { fp in
                        Button { editingFootprint = fp } label: {
                            FootprintRow(footprint: fp)
                        }
                        .buttonStyle(.plain)
                    }
                    .onDelete { indexSet in
                        let targets = indexSet.map { store.footprints[$0] } // 删除前按索引快照，避免边删边移位
                        Task {
                            for footprint in targets {
                                do {
                                    try await store.delete(footprint)
                                } catch {
                                    // 服务端删除失败：该条已不再本地假删（FootprintStore.delete 契约），
                                    // 这里只需把错误亮给用户；列表因为没被改动，视觉上会"弹回"未删态。
                                    deleteError = "删除失败：\(error.localizedDescription)"
                                }
                            }
                        }
                    }
                }
                #if !targetEnvironment(macCatalyst)
                Section {
                    Button { showImport = true } label: {
                        Label("从相册点亮过去的旅行", systemImage: "photo.stack.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(ZXPrimaryButtonStyle())
                    .listRowBackground(Color.clear)
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                }
                Section {
                    Button(role: .destructive) { session.signOut() } label: {
                        Label("退出登录", systemImage: "rectangle.portrait.and.arrow.right")
                            .frame(maxWidth: .infinity)
                    }
                }
                #endif
            }
            .scrollContentBackground(.hidden)
            .background(ZXTheme.canvas)
            .navigationTitle("我的知行")
            #if !targetEnvironment(macCatalyst)
            .sheet(isPresented: $showImport) { AlbumImportScreen().appStores() }
            #endif
            .sheet(item: $editingFootprint) { fp in FootprintEditor(footprint: fp).appStores() }
            .task { await store.load() }
            .alert(
                "删除失败", isPresented: Binding(
                    get: { deleteError != nil },
                    set: { if !$0 { deleteError = nil } }
                ), presenting: deleteError
            ) { _ in
                Button("好", role: .cancel) {}
            } message: { message in
                Text(message)
            }
        }
    }

    private var profileHeader: some View {
        HStack(spacing: 14) {
            Image(systemName: "person.crop.circle.fill")
                .font(.system(size: 44, weight: .light))
                .foregroundStyle(ZXTheme.pine)
            VStack(alignment: .leading, spacing: 3) {
                Text(session.user?.nickname ?? "知行旅人")
                    .font(.system(.title2, design: .serif, weight: .bold))
                Text("每一段路，都在地图上慢慢长成你的故事。")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
        .padding(.top, 4)
    }

    private var statsRow: some View {
        HStack(spacing: 0) {
            statCell(store.stats?.footprints, "足迹")
            Divider().frame(height: 32)
            statCell(store.stats?.places, "地点")
            Divider().frame(height: 32)
            statCell(store.stats?.cities, "城市")
            Divider().frame(height: 32)
            statCell(store.stats?.provinces, "省份")
        }
        .padding(.vertical, 12)
        .padding(.horizontal, 4)
        .background(ZXTheme.surface, in: RoundedRectangle(cornerRadius: 18))
        .overlay {
            RoundedRectangle(cornerRadius: 18)
                .stroke(ZXTheme.pine.opacity(0.08), lineWidth: 1)
        }
    }

    private func statCell(_ value: Int?, _ label: String) -> some View {
        VStack(spacing: 2) {
            Text("\(value ?? 0)")
                .font(.system(.title2, design: .rounded, weight: .bold))
                .foregroundStyle(ZXTheme.pine)
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }

    private func destinationRow(icon: String, title: String, subtitle: String) -> some View {
        HStack(spacing: 13) {
            Image(systemName: icon)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(ZXTheme.pine)
                .frame(width: 36, height: 36)
                .background(ZXTheme.jade.opacity(0.11), in: RoundedRectangle(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.headline)
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 3)
    }
}

struct FootprintRow: View {
    let footprint: Footprint

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                Text(footprint.place.name).font(.headline)
                if let badge = footprint.publishBadge {
                    PublishBadgeLabel(badge: badge)
                }
                Spacer()
                Text(footprint.date, format: .dateTime.year().month().day())
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let text = footprint.text, !text.isEmpty {
                Text(text).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
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
