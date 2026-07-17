# 网友攻略第四分栏实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把地点抽屉里拼在风物卡列表底部的「网友攻略」外链区块，升级为与风物卡/旅人故事/旅人镜头并列的第四个分栏（自足式 tab，失败可重试，无链接常驻空态）。

**Architecture:** `PlaceDrawer` 的 `DrawerSection` 枚举三段变四段（网友攻略插在风物卡之后）；`PlaceLinksSection` 从"被动接 links 数组的区块"改造成与 `StoriesSection`/`PhotoWallSection` 同构的自足式 tab——入参 `placeId`，自己请求 `GET /places/{id}` 取 `links`，`LoadState` 三态渲染。纯 iOS 改动，服务端/管理端零变更。

**Tech Stack:** SwiftUI（iOS 17+ / Swift 6）、XcodeGen、XCTest 源码断言（`InteractionDesignTests` 惯例）。

**Spec:** docs/superpowers/specs/2026-07-17-place-links-tab-design.md

## Global Constraints

- `apps/ios/Zhixing.xcodeproj` 是构建产物，绝不手改；改 `project.yml` 后须 `xcodegen generate`（本计划不改 project.yml，无新增文件）。
- 网络错误必须可见可重试（I2+ 全局约束）：失败走 `LoadStateView` 重试路径，不得伪装成空态。
- 注释、文档、提交信息一律中文；提交遵循 conventional commits（`feat(ios): ...`）。
- 跑 iOS 测试需要 Docker 无关、但需要本机有可用 iPhone 模拟器（`scripts/ios-test.sh` 自动选第一台）。

---

### Task 1: 网友攻略升级为自足式第四分栏

**Files:**
- Modify: `apps/ios/Tests/InteractionDesignTests.swift`（文件末尾、类内追加一条用例）
- Modify: `apps/ios/Zhixing/Place/PlaceLinksSection.swift`（整文件重写）
- Modify: `apps/ios/Zhixing/Place/PlaceDrawer.swift:14-19`（枚举）、`:109-119`（sectionContent）、`:166-169`（移除底部拼接）
- Modify: `apps/ios/Zhixing/Core/Models.swift:19,26`（两行过时注释）

**Interfaces:**
- Consumes: `LoadState<Value>` / `LoadStateView(state:retry:content:)`（Core/LoadState.swift）；`ZXSectionEmptyState(icon:eyebrow:title:message:)`（Core/ZhixingTheme.swift）；`APIClient.shared.get<T: Decodable>(_ path: String) async throws -> T`（Core/APIClient.swift）；`PlaceDetail.links: [PlaceLink]?`（Core/Models.swift）；`Pin.id: String`。
- Produces: `PlaceLinksSection(placeId: String)`——`PlaceDrawer.sectionContent` 装配的新初始化器；旧的 `PlaceLinksSection(links:)` 初始化器随之消失，全库唯一调用点就在 PlaceDrawer 内（本任务一并改掉）。

**设计要点（评审时对照）:**
- 有意变化 ①：链接列表顶部原有的 `Label("网友攻略", systemImage: "link")` 标题删除——分段控件已写明 tab 名，与风物卡/旅人故事 tab 内不再重复标题的做法对齐。
- 有意变化 ②：M3 spec「无链接时区块整体不渲染」被本设计取代——tab 常驻，空数组与解码出 nil 都进空态。
- 不变：链接行样式（平台胶囊徽章+标题+右上箭头）、打开行为（iOS 应用内 Safari / Catalyst 系统浏览器、仅放行 https）原样保留。
- 抽屉自身的静默 `loadDetail()` 不动（仍供头部路径文字与卡片详情位置兜底）。

- [x] **Step 1: 写失败的守卫测试**

在 `apps/ios/Tests/InteractionDesignTests.swift` 的 `InteractionDesignTests` 类内、最后一个测试方法之后追加：

```swift
    func testPlaceLinksIsAStandaloneDrawerSection() throws {
        let drawer = try source("Place/PlaceDrawer.swift")
        let links = try source("Place/PlaceLinksSection.swift")

        // 四段分栏,网友攻略紧随风物卡之后
        let cards = try XCTUnwrap(drawer.range(of: "case cards = \"风物卡\""))
        let guides = try XCTUnwrap(drawer.range(of: "case links = \"网友攻略\""))
        let stories = try XCTUnwrap(drawer.range(of: "case stories = \"旅人故事\""))
        XCTAssertTrue(cards.lowerBound < guides.lowerBound)
        XCTAssertTrue(guides.lowerBound < stories.lowerBound)

        // 抽屉以 placeId 装配自足式分栏;风物卡列表不再拼接链接区块
        XCTAssertTrue(drawer.contains("PlaceLinksSection(placeId: pin.id)"))
        XCTAssertFalse(drawer.contains("PlaceLinksSection(links:"))

        // 自足式加载:失败可见可重试(LoadStateView),空态与失败分离
        XCTAssertTrue(links.contains("LoadState<[PlaceLink]>"))
        XCTAssertTrue(links.contains("LoadStateView(state: state, retry:"))
        XCTAssertTrue(links.contains("ZXSectionEmptyState"))
        XCTAssertTrue(links.contains("攻略还在收集中"))
    }
```

- [x] **Step 2: 跑单测确认失败**

```sh
cd apps/ios && xcodegen generate
SIM=$(xcrun simctl list devices available | grep -oE "iPhone [^(]+" | head -1 | xargs)
xcodebuild -project Zhixing.xcodeproj -scheme Zhixing \
  -destination "platform=iOS Simulator,name=$SIM" \
  -only-testing:ZhixingTests/InteractionDesignTests/testPlaceLinksIsAStandaloneDrawerSection test
```

Expected: **FAIL**——`XCTUnwrap` 在 `case links = "网友攻略"` 一行抛错（枚举尚无该 case）。应用源码未动，编译必须成功；若编译失败说明测试写坏了，先修。

- [x] **Step 3: 整文件重写 PlaceLinksSection.swift**

`apps/ios/Zhixing/Place/PlaceLinksSection.swift` 全文替换为：

```swift
import SafariServices
import SwiftUI

/// 地点抽屉「网友攻略」分栏:管理员维护的外部平台链接列表。
/// 自足式 tab(与 StoriesSection/PhotoWallSection 同构):自己请求 /places/{id} 取 links,
/// LoadState 保证失败可见可重试——失败 ≠ 空态,无链接才进空态。
/// iOS 用 SFSafariViewController 应用内打开;Catalyst 交给系统默认浏览器。
struct PlaceLinksSection: View {
    let placeId: String

    @State private var state: LoadState<[PlaceLink]> = .loading
    @State private var safariURL: URL?

    var body: some View {
        LoadStateView(state: state, retry: { Task { await load() } }) { links in
            ScrollView {
                LazyVStack(spacing: 10) {
                    if links.isEmpty {
                        ZXSectionEmptyState(
                            icon: "link",
                            eyebrow: "网友攻略",
                            title: "攻略还在收集中",
                            message: "我们会陆续为这里挑选值得一看的网友攻略与带玩视频。")
                    }
                    ForEach(links) { link in
                        Button {
                            open(link)
                        } label: {
                            HStack(spacing: 12) {
                                Text(link.platformLabel)
                                    .font(.caption2.weight(.semibold))
                                    .padding(.horizontal, 8).padding(.vertical, 3)
                                    .foregroundStyle(.white)
                                    .background(ZXTheme.cinnabar, in: Capsule())
                                Text(link.title)
                                    .font(.subheadline)
                                    .foregroundStyle(.primary)
                                    .lineLimit(1)
                                Spacer(minLength: 8)
                                Image(systemName: "arrow.up.right")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.tertiary)
                            }
                            .zxSurface(radius: 14, padding: 13)
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint("在浏览器中打开")
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .task { await load() }
        #if !targetEnvironment(macCatalyst)
        .sheet(item: Binding(
            get: { safariURL.map(SafariItem.init) },
            set: { if $0 == nil { safariURL = nil } }
        )) { item in
            SafariView(url: item.url).ignoresSafeArea().appStores()
        }
        #endif
    }

    private func load() async {
        state = .loading
        do {
            // 复用地点详情接口:links 字段可选容错,旧服务端/缓存缺字段时按空处理
            let detail: PlaceDetail = try await APIClient.shared.get("/places/\(placeId)")
            state = .loaded(detail.links ?? [])
        } catch {
            state = .failed("网友攻略加载失败，请重试")
        }
    }

    private func open(_ link: PlaceLink) {
        guard let url = URL(string: link.url), url.scheme == "https" else { return }
        #if targetEnvironment(macCatalyst)
        UIApplication.shared.open(url) // Catalyst → 系统默认浏览器
        #else
        safariURL = url
        #endif
    }
}

#if !targetEnvironment(macCatalyst)
private struct SafariItem: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}

private struct SafariView: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }
    func updateUIViewController(_ vc: SFSafariViewController, context: Context) {}
}
#endif
```

（链接行 Button、`open(_:)`、SafariItem/SafariView 与现文件逐字相同，只有外层从"接数组的 VStack 区块"换成"LoadStateView + ScrollView 的自足式 tab"。）

- [x] **Step 4: 改 PlaceDrawer.swift（三处）**

① 枚举（原 14-19 行）：

```swift
    /// 三段式 tab：风物卡（M1 落地）/ 旅人故事（I4）/ 旅人镜头（本任务，I5）。
    private enum DrawerSection: String, CaseIterable, Hashable {
        case cards = "风物卡"
        case stories = "旅人故事"
        case photos = "旅人镜头"
    }
```

替换为：

```swift
    /// 四段式 tab：风物卡（M1 落地）/ 网友攻略（原风物卡底部区块升级）/ 旅人故事（I4）/ 旅人镜头（I5）。
    private enum DrawerSection: String, CaseIterable, Hashable {
        case cards = "风物卡"
        case links = "网友攻略"
        case stories = "旅人故事"
        case photos = "旅人镜头"
    }
```

② `sectionContent`（原 109-119 行）加 case：

```swift
        switch section {
        case .cards:
            cardsContent
        case .stories:
```

替换为：

```swift
        switch section {
        case .cards:
            cardsContent
        case .links:
            PlaceLinksSection(placeId: pin.id)
        case .stories:
```

③ `cardsContent` 移除底部拼接（原 166-169 行整段删除）：

```swift
                if let links = placeDetail?.links, !links.isEmpty {
                    PlaceLinksSection(links: links)
                        .padding(.top, 6)
                }
```

删除后 `ForEach(cards) { ... }` 的收尾直接接 `}`、`.padding(.horizontal, 16)`。`placeDetail` 仍被头部路径文字与 `drawerLocationText` 使用，静默 `loadDetail()` 一字不动。

- [x] **Step 5: 更新 Models.swift 两行过时注释**

`apps/ios/Zhixing/Core/Models.swift` 第 19 行：

```swift
/// `GET /places/:id` 的地点详情:抽屉头部路径与后续攻略区共用。
```

改为：

```swift
/// `GET /places/:id` 的地点详情:抽屉头部路径与网友攻略分栏共用。
```

第 26 行（`links` 字段注释）：

```swift
    /// 旧服务端/缓存无此字段,可选容错;空数组与 nil 均不渲染攻略区。
```

改为：

```swift
    /// 旧服务端/缓存无此字段,可选容错;网友攻略分栏自行请求本接口,空数组与 nil 都进空态。
```

- [x] **Step 6: 跑单测确认通过**

与 Step 2 相同命令。Expected: **PASS**（`Test Case ... passed`）。

- [x] **Step 7: 全量 iOS 回归**

```sh
cd ../.. && scripts/ios-test.sh
```

Expected: 全部测试通过（`** TEST SUCCEEDED **`）。重点关注 `InteractionDesignTests`（其余既有用例断言的 PlaceDrawer 片段——`requestComposeFootprint` 等——本次未动）与 `ModelsTests`（`PlaceDetail` 字段未动，应无波动）。

- [x] **Step 8: 提交**

```sh
git add apps/ios/Zhixing/Place/PlaceLinksSection.swift apps/ios/Zhixing/Place/PlaceDrawer.swift apps/ios/Zhixing/Core/Models.swift apps/ios/Tests/InteractionDesignTests.swift
git commit -m "feat(ios): 网友攻略升级为地点抽屉第四分栏

分段控件三变四(风物卡/网友攻略/旅人故事/旅人镜头);链接区块从风物卡列表底部抽出,
PlaceLinksSection 改自足式 tab——自请求 /places/{id},LoadState 失败可重试,无链接常驻空态。
spec: docs/superpowers/specs/2026-07-17-place-links-tab-design.md

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## 收尾（人工）

模拟器走查一遍最终观感（源码断言锁不住视觉）：潭柘寺（有链接）四个 tab 切换、链接打开；任选无链接地点看空态；断网看失败+重试。走查结论记录在提交或对话里即可，不新开文档。
