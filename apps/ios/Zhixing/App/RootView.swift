import SwiftUI

struct RootView: View {
    @Environment(SessionStore.self) private var session
    @Environment(FootprintStore.self) private var footprints
    @Environment(FavoritesStore.self) private var favorites

    var body: some View {
        Group {
            if session.restoring {
                ZStack {
                    ZXTheme.canvas.ignoresSafeArea()
                    VStack(spacing: 14) {
                        Image(systemName: "map.fill")
                            .font(.system(size: 28, weight: .light))
                            .foregroundStyle(ZXTheme.pine)
                        ProgressView("正在展开地图…")
                            .tint(ZXTheme.pine)
                            .foregroundStyle(.secondary)
                    }
                }
            } else if session.isSignedIn {
                MainTabView()
            } else {
                SignInScreen()
            }
        }
        .tint(ZXTheme.pine)
        .task { await session.restore() }
        .onChange(of: session.isSignedIn) { _, signedIn in
            // 登出/会话失效的统一清理点：所有"用户私有数据 store"都必须在这里 reset（§5.1 防跨账号泄露）。
            // PinsCache 不在此列并非遗漏：它缓存的是 `GET /places/pins`——无鉴权、与登录用户无关的
            // 公共地点数据（同一份数据登录前/登录后/换号后都一样），保留跨账号复用没有泄露风险，
            // 清掉反而白白让下一个账号重新拉一遍网络（违背该 store 本身"收敛重复请求"的目的）。
            // 复核一遍其余 store：SessionStore 自身在 signOut() 里清；RemoteConfig 是无鉴权公共配置
            // （同 PinsCache 不涉及用户身份，理由同上）；ViewTracker 只是进程内浏览打点去重 Set，不
            // 持有任何可读内容，换号后至多让一次重复浏览漏打点，不构成隐私泄露。截至 I10 没有新增
            // 遗漏的私有 store。
            if !signedIn {
                footprints.reset()
                favorites.reset()
            }
        }
    }
}

struct MainTabView: View {
    var body: some View {
        #if targetEnvironment(macCatalyst)
        DesktopMainView()
        #else
        TabView {
            MapScreen().tabItem { Label("地图", systemImage: "map.fill") }
            MeScreen().tabItem { Label("我的", systemImage: "person.fill") }
        }
        .tint(ZXTheme.pine)
        #endif
    }
}

#if targetEnvironment(macCatalyst)
private enum DesktopDestination: Hashable {
    case map
    case me
}

/// Catalyst 宽屏壳层：把手机底部 Tab 换成可识别的桌面侧栏，地图获得稳定的主工作区。
private struct DesktopMainView: View {
    @Environment(SessionStore.self) private var session
    @State private var selection: DesktopDestination? = .map
    @State private var showImport = false

    var body: some View {
        NavigationSplitView {
            List(selection: $selection) {
                Section("探索") {
                    Label("故事地图", systemImage: "map.fill")
                        .tag(DesktopDestination.map)
                }
                Section("个人") {
                    Label("我的知行", systemImage: "person.crop.circle")
                        .tag(DesktopDestination.me)
                }
                Section {
                    Button { showImport = true } label: {
                        Label {
                            Text("从相册点亮旅行")
                                .foregroundStyle(.primary)
                        } icon: {
                            Image(systemName: "photo.stack.fill")
                                .foregroundStyle(ZXTheme.pine)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("从相册点亮过去的旅行")
                    .accessibilityLabel("从相册点亮过去的旅行")
                } header: {
                    Text("快捷操作")
                } footer: {
                    Label("导入的足迹默认仅自己可见", systemImage: "lock.fill")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .listStyle(.sidebar)
            .navigationTitle("知行")
            .navigationSplitViewColumnWidth(min: 200, ideal: 228, max: 280)
            .safeAreaInset(edge: .top) {
                HStack(spacing: 11) {
                    Image(systemName: "map.fill")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 38, height: 38)
                        .background(ZXTheme.pine, in: RoundedRectangle(cornerRadius: 11))
                    VStack(alignment: .leading, spacing: 1) {
                        Text("知行")
                            .font(.system(.title3, design: .serif, weight: .bold))
                        Text("一张有故事的中国地图")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(.ultraThinMaterial)
            }
            .safeAreaInset(edge: .bottom) {
                sidebarAccountAction
            }
        } detail: {
            switch selection ?? .map {
            case .map:
                MapScreen()
            case .me:
                MeScreen()
            }
        }
        .navigationSplitViewStyle(.balanced)
        .tint(ZXTheme.pine)
        .sheet(isPresented: $showImport) {
            AlbumImportScreen().appStores()
        }
    }

    /// 低频账户操作独立沉底，与导航和相册导入拉开距离，避免视觉竞争与误触。
    private var sidebarAccountAction: some View {
        VStack(spacing: 0) {
            Divider()
            Button(role: .destructive) { session.signOut() } label: {
                Label("退出登录", systemImage: "rectangle.portrait.and.arrow.right")
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                    .padding(.horizontal, 8)
                    .padding(.vertical, 8)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .help("退出当前账户")
            .accessibilityLabel("退出当前账户")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(.ultraThinMaterial)
    }
}
#endif
