# 足迹详情页实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给私密足迹补上"读"路径——新增推入式 `FootprintDetailView`（完整正文 + 全部照片 + 公开统计），「最近足迹」与「地点足迹」两处列表点行改推详情，编辑降级为详情页右上角入口；全屏照片浏览器抽成通用 `ZXPhotoBrowser`，照片墙一并迁移。

**Architecture:** 纯 iOS 视图层改动、零新增 API：详情页按 id 从 `FootprintStore` 取实时值（编辑保存后随 `store.update` 就地替换自动刷新；编辑弹层里删除后等弹层收起再退栈）。`ZXPhotoBrowser` 由 `PhotoWallSection` 私有的 `PhotoWallBrowser` 泛化搬迁，底栏经 `@ViewBuilder` 注入（照片墙注入「查看故事」，详情无底栏）。测试 = 源码断言（`InteractionDesignTests` 惯例）锁交互契约 + 全量回归。

**Tech Stack:** SwiftUI（Swift 6，iOS 17+）、XcodeGen、XCTest。设计 spec：`docs/superpowers/specs/2026-07-17-footprint-detail-design.md`。

## Global Constraints

- 注释、文档、提交信息一律中文；提交遵循 conventional commits（本计划三个代码提交均为 `feat(ios): …`）。
- `Zhixing.xcodeproj` 是构建产物，严禁手改；`scripts/ios-test.sh` 自带 `xcodegen generate`，新增源文件后直接跑它即可入工程。
- 测试统一跑 `scripts/ios-test.sh`（真模拟器全量回归）。若报 "Unable to boot device"/"Busy" 类**启动失败**，是模拟器瞬态问题而非测试失败，重跑一次即可。
- 直接提交到 `main`，**不要 push**（用户批量推送）。
- 既定设计决策，不得"顺手优化"：详情页排版沿用 `StoryDetailView` 语言（maxWidth 720 居中、正文 serif + lineSpacing 9 + 可选中、照片整宽 minHeight 220 / maxHeight 280、圆角 18 continuous）；浏览器视觉与现状 `PhotoWallBrowser` 逐一保持（TabView `.page`、黑底、`ignoresSafeArea`、右上 xmark thinMaterial 圆钮、`preferredColorScheme(.dark)`）。
- `FootprintEditor` 零改动；列表行（宫格封顶 +N、左滑删除、行高）除点击目标外不动。
- 每一处 sheet/fullScreenCover 内容都必须挂 `.appStores()`（Catalyst modal 宿主不继承 WindowGroup 环境，见 `Core/AppStores.swift`）；NavigationLink 推入继承环境，不需要。

---

### Task 1: 通用全屏浏览器 ZXPhotoBrowser，照片墙迁移（TDD）

**Files:**
- Create: `apps/ios/Zhixing/Core/ZXPhotoBrowser.swift`
- Modify: `apps/ios/Zhixing/Place/PhotoWallSection.swift`（`.fullScreenCover` 块约 32–47 行；文件末尾私有 `PhotoWallBrowser` 约 164–222 行整块删除）
- Test: `apps/ios/Tests/FootprintDetailTests.swift`（新建）

**Interfaces:**
- Consumes: `AuthedPhotoView(photoId: String)`（`Footprint/AuthedPhotoView.swift`，loaded 分支 `scaledToFill`，依赖外部 frame/clip 约束）；`WallPhoto`（`Core/Models.swift:150`，`id` 就是 `photoId`，`footprintId` 供「查看故事」反查）。
- Produces（Task 2 依赖）: `struct ZXPhotoBrowser<BottomBar: View>: View`，两个构造：
  `ZXPhotoBrowser(photoIds: [String], startIndex: Int, onClose: @escaping () -> Void, @ViewBuilder bottomBar: @escaping (Int) -> BottomBar)`（bottomBar 参数 = 当前页下标）；
  无底栏便捷构造 `ZXPhotoBrowser(photoIds:startIndex:onClose:)`（`BottomBar == EmptyView`）。

- [ ] **Step 1: 写失败测试**

新建 `apps/ios/Tests/FootprintDetailTests.swift`，完整内容：

```swift
import XCTest
@testable import Zhixing

/// 足迹详情页与通用全屏浏览器的交互契约（spec：2026-07-17-footprint-detail-design.md）：
/// 私密足迹的"读"路径——列表点行进详情，编辑降级为详情页右上角入口；
/// 全屏照片浏览器抽成通用组件，照片墙与足迹详情共用。
final class FootprintDetailTests: XCTestCase {
    private func source(_ relativePath: String) throws -> String {
        let testsDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let sourceURL = testsDirectory.deletingLastPathComponent()
            .appendingPathComponent("Zhixing/\(relativePath)")
        return try String(contentsOf: sourceURL, encoding: .utf8)
    }

    /// 照片墙必须复用通用浏览器，私有 PhotoWallBrowser 不复存在；
    /// 通用组件不得内置「查看故事」这类业务按钮（底栏由调用方注入）。
    func testPhotoWallUsesSharedBrowser() throws {
        let browser = try source("Core/ZXPhotoBrowser.swift")
        let wall = try source("Place/PhotoWallSection.swift")

        XCTAssertTrue(wall.contains("ZXPhotoBrowser("))
        XCTAssertFalse(wall.contains("struct PhotoWallBrowser"))
        XCTAssertFalse(browser.contains("查看故事"))
        // 页身份必须绑照片 id 而非位置：AuthedPhotoView 的 @State 缓存跟随视图身份
        //（同 ZXPhotoThumbRow 的护栏理由），不得回退按 offset。
        XCTAssertTrue(browser.contains("id: \\.element"))
        XCTAssertFalse(browser.contains("id: \\.offset"))
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `scripts/ios-test.sh`
Expected: `testPhotoWallUsesSharedBrowser` 失败——`source("Core/ZXPhotoBrowser.swift")` 抛"文件不存在"。其余用例全绿。

- [ ] **Step 3: 新建 ZXPhotoBrowser 组件**

新建 `apps/ios/Zhixing/Core/ZXPhotoBrowser.swift`，完整内容：

```swift
import SwiftUI

/// 全屏照片浏览器：TabView 分页、黑底、右上角关闭。photoIds 顺序由调用方保证，本视图不重排。
/// 由 PhotoWallSection 私有的 PhotoWallBrowser 泛化而来：底部操作区经 bottomBar 注入
///（照片墙注入跳转故事的业务按钮；足迹详情无底栏走 EmptyView 便捷构造——
/// 组件源码不得出现具体业务文案，FootprintDetailTests 有断言）。
/// 设计：docs/superpowers/specs/2026-07-17-footprint-detail-design.md
struct ZXPhotoBrowser<BottomBar: View>: View {
    let photoIds: [String]
    let onClose: () -> Void
    @ViewBuilder let bottomBar: (Int) -> BottomBar

    @State private var selection: Int

    init(
        photoIds: [String], startIndex: Int, onClose: @escaping () -> Void,
        @ViewBuilder bottomBar: @escaping (Int) -> BottomBar
    ) {
        self.photoIds = photoIds
        self.onClose = onClose
        self.bottomBar = bottomBar
        _selection = State(initialValue: startIndex)
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            TabView(selection: $selection) {
                // 页身份绑照片 id：AuthedPhotoView 的 @State 图片缓存跟随视图身份
                //（同 ZXPhotoThumbRow 的护栏理由）；photoIds 在浏览会话内不变，tag 用下标翻页。
                ForEach(Array(photoIds.enumerated()), id: \.element) { index, photoId in
                    AuthedPhotoView(photoId: photoId)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .clipped()
                        .tag(index)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .background(Color.black)
            .ignoresSafeArea()

            Button(action: onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .semibold))
                    .frame(width: 36, height: 36)
                    .background(.thinMaterial, in: Circle())
            }
            .accessibilityLabel("关闭")
            .padding()
        }
        .safeAreaInset(edge: .bottom) {
            bottomBar(selection)
        }
        .preferredColorScheme(.dark)
    }
}

extension ZXPhotoBrowser where BottomBar == EmptyView {
    /// 无底栏便捷构造（足迹详情用）。
    init(photoIds: [String], startIndex: Int, onClose: @escaping () -> Void) {
        self.init(photoIds: photoIds, startIndex: startIndex, onClose: onClose) { _ in EmptyView() }
    }
}
```

- [ ] **Step 4: 照片墙迁移到 ZXPhotoBrowser**

`apps/ios/Zhixing/Place/PhotoWallSection.swift` 中，把 `.fullScreenCover` 块：

```swift
        .fullScreenCover(item: $browseSession) { session in
            PhotoWallBrowser(
                photos: session.photos, startIndex: session.startIndex,
                onClose: { browseSession = nil },
                onViewStory: { footprintId in
                    pendingStoryTarget = StoryTarget(footprintId: footprintId)
                    browseSession = nil // 先关全屏浏览；sheet 交给下面 onDisappear 接手
                })
                .onDisappear {
                    if let pending = pendingStoryTarget {
                        pendingStoryTarget = nil
                        storyTarget = pending
                    }
                }
                .appStores()
        }
```

整块替换为（「查看故事」底栏改为注入，样式与原 PhotoWallBrowser 底栏逐字一致；`pendingStoryTarget`/`onDisappear` 串行接手链路不动）：

```swift
        .fullScreenCover(item: $browseSession) { session in
            ZXPhotoBrowser(
                photoIds: session.photos.map(\.photoId), startIndex: session.startIndex,
                onClose: { browseSession = nil }
            ) { index in
                Button {
                    guard session.photos.indices.contains(index) else { return }
                    pendingStoryTarget = StoryTarget(footprintId: session.photos[index].footprintId)
                    browseSession = nil // 先关全屏浏览；sheet 交给下面 onDisappear 接手
                } label: {
                    Text("查看故事")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                }
                .buttonStyle(.borderedProminent)
                .padding(.horizontal)
                .padding(.bottom, 8)
                .background(.ultraThinMaterial)
            }
            .onDisappear {
                if let pending = pendingStoryTarget {
                    pendingStoryTarget = nil
                    storyTarget = pending
                }
            }
            .appStores()
        }
```

然后把文件末尾的 `private struct PhotoWallBrowser: View { … }` 整个 struct（含其上方的文档注释 `/// 全屏照片浏览器：TabView 分页；…`）删除。

- [ ] **Step 5: 跑测试确认全绿**

Run: `scripts/ios-test.sh`
Expected: `** TEST SUCCEEDED **`，新用例通过，既有用例（含 `PhotoThumbRowTests`、`InteractionDesignTests`）不受影响。

- [ ] **Step 6: 提交**

```bash
git add apps/ios/Zhixing/Core/ZXPhotoBrowser.swift apps/ios/Zhixing/Place/PhotoWallSection.swift apps/ios/Tests/FootprintDetailTests.swift
git commit -m "feat(ios): 全屏照片浏览器抽成通用组件 ZXPhotoBrowser"
```

---

### Task 2: 足迹详情页 FootprintDetailView（TDD）

**Files:**
- Create: `apps/ios/Zhixing/Footprint/FootprintDetailView.swift`
- Test: `apps/ios/Tests/FootprintDetailTests.swift`（追加一条用例）

**Interfaces:**
- Consumes: Task 1 的 `ZXPhotoBrowser(photoIds:startIndex:onClose:)` 便捷构造；`FootprintStore.footprints: [Footprint]`（`@Observable`，`update` 成功后就地替换元素、`delete` 成功后移除元素）；`FootprintEditor(footprint: Footprint)` 与 `PublishBadgeLabel(badge: PublishBadge)`（均在 `Footprint/FootprintEditor.swift`，零改动）；`Footprint`（`Core/Models.swift:98`：`text/date/place/photos/likeCount/viewCount/publishBadge`）；`.appStores()`（`Core/AppStores.swift`）。
- Produces（Task 3 依赖）: `struct FootprintDetailView: View`，初始化 `FootprintDetailView(footprint: Footprint)`。

- [ ] **Step 1: 追加失败测试**

在 `FootprintDetailTests` 类末尾（`testPhotoWallUsesSharedBrowser` 之后）追加：

```swift
    /// 详情页契约：编辑入口在工具栏、照片可全屏浏览、公开足迹显示获赞/浏览统计、
    /// 编辑弹层内删除后等弹层收起再退栈（串行接手，同 PhotoWallSection 惯例）、modal 挂 appStores。
    func testDetailKeepsEditEntryBrowserAndStats() throws {
        let detail = try source("Footprint/FootprintDetailView.swift")

        XCTAssertTrue(detail.contains("FootprintEditor(footprint:"))
        XCTAssertTrue(detail.contains("ZXPhotoBrowser("))
        XCTAssertTrue(detail.contains(".fullScreenCover"))
        XCTAssertTrue(detail.contains("获赞") && detail.contains("浏览"))
        XCTAssertTrue(detail.contains(".onDisappear"))
        XCTAssertTrue(detail.contains(".appStores()"))
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `scripts/ios-test.sh`
Expected: 仅 `testDetailKeepsEditEntryBrowserAndStats` 失败（`Footprint/FootprintDetailView.swift` 不存在），其余全绿。

- [ ] **Step 3: 写详情页实现**

新建 `apps/ios/Zhixing/Footprint/FootprintDetailView.swift`，完整内容：

```swift
import SwiftUI

/// 私密足迹详情：完整正文 + 全部照片的"读"路径，从「最近足迹」/「地点足迹」行点击推入。
/// 零新增请求——Footprint 模型已带全量字段；渲染优先取 FootprintStore 中同 id 的实时值，
/// 编辑保存后随 store.update 就地替换自动刷新；编辑弹层里删除足迹后等弹层收起再退栈
///（串行接手，同 PhotoWallSection.pendingStoryTarget 惯例——sheet 收起与导航 pop 不同帧竞争）。
/// 设计：docs/superpowers/specs/2026-07-17-footprint-detail-design.md
struct FootprintDetailView: View {
    let footprint: Footprint
    @Environment(\.dismiss) private var dismiss
    @Environment(FootprintStore.self) private var store

    @State private var showEditor = false
    @State private var browseStart: BrowseStart?

    /// store 实时值优先；兜底进场快照——本视图只从 store 驱动的列表行进入，正常不会走到兜底。
    private var current: Footprint {
        store.footprints.first { $0.id == footprint.id } ?? footprint
    }

    private var deleted: Bool {
        !store.footprints.contains { $0.id == footprint.id }
    }

    var body: some View {
        ZStack {
            ZXTheme.canvas.ignoresSafeArea()
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    Text("这 一 刻")
                        .font(.caption.weight(.semibold))
                        .tracking(3)
                        .foregroundStyle(ZXTheme.cinnabar)
                    HStack(spacing: 10) {
                        Image(systemName: "mappin.circle.fill")
                            .font(.title2)
                            .foregroundStyle(ZXTheme.cinnabar)
                        Text(current.place.name).font(.headline)
                        if let badge = current.publishBadge {
                            PublishBadgeLabel(badge: badge)
                        }
                        Spacer()
                        Text(current.date, format: .dateTime.year().month().day()
                            .locale(Locale(identifier: "zh_Hans_CN")))
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    if let text = current.text, !text.isEmpty {
                        Text(text)
                            .font(.system(.body, design: .serif))
                            .lineSpacing(9)
                            .textSelection(.enabled)
                    }
                    if current.publishBadge == .published {
                        Text("获赞 \(current.likeCount) · 浏览 \(current.viewCount)")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    // 身份绑照片 id（AuthedPhotoView @State 缓存跟随视图身份，同 ZXPhotoThumbRow 护栏）。
                    ForEach(Array(current.photos.enumerated()), id: \.element.id) { index, photo in
                        Button { browseStart = BrowseStart(index: index) } label: {
                            AuthedPhotoView(photoId: photo.id)
                                .frame(maxWidth: .infinity, minHeight: 220, maxHeight: 280)
                                .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("第 \(index + 1) 张照片，共 \(current.photos.count) 张，点按全屏查看")
                    }
                }
                .frame(maxWidth: 720, alignment: .leading)
                .padding(.horizontal, 28)
                .padding(.vertical, 28)
                .frame(maxWidth: .infinity)
            }
        }
        .navigationTitle("足迹详情")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("编辑") { showEditor = true }
            }
        }
        .sheet(isPresented: $showEditor) {
            FootprintEditor(footprint: current)
                .appStores()
                .onDisappear {
                    // 编辑弹层里删了足迹：等弹层真正收起后再退栈，避免 sheet 收起与导航 pop 同帧竞争。
                    if deleted { dismiss() }
                }
        }
        .fullScreenCover(item: $browseStart) { start in
            ZXPhotoBrowser(
                photoIds: current.photos.map(\.id), startIndex: start.index,
                onClose: { browseStart = nil })
                .appStores()
        }
    }

    /// 全屏浏览起点：下标装箱成 Identifiable 供 .fullScreenCover(item:) 使用（同 PhotoWallSection.BrowseSession）。
    private struct BrowseStart: Identifiable {
        let index: Int
        var id: Int { index }
    }
}
```

- [ ] **Step 4: 跑测试确认全绿**

Run: `scripts/ios-test.sh`
Expected: `** TEST SUCCEEDED **`，新用例通过（此时详情页尚无入口，属预期——入口在 Task 3 接线）。

- [ ] **Step 5: 提交**

```bash
git add apps/ios/Zhixing/Footprint/FootprintDetailView.swift apps/ios/Tests/FootprintDetailTests.swift
git commit -m "feat(ios): 新增足迹详情页 FootprintDetailView"
```

---

### Task 3: 两处列表入口改推详情

**Files:**
- Modify: `apps/ios/Zhixing/Me/MeScreen.swift`（第 7 行 state、47–52 行行点击、92 行编辑 sheet）
- Modify: `apps/ios/Zhixing/Me/MyMapScreen.swift`（`FootprintPlaceSheet`：约 192 行 state、219–226 行行点击、237–239 行编辑 sheet）
- Test: `apps/ios/Tests/FootprintDetailTests.swift`（追加一条用例）

**Interfaces:**
- Consumes: Task 2 的 `FootprintDetailView(footprint: Footprint)`。
- Produces: 无新接口；编辑器从此只经详情页工具栏进入（`FootprintComposer.swift` 注释"创建后的公开状态变更走 FootprintEditor"仍然成立）。

- [ ] **Step 1: 追加失败测试**

在 `FootprintDetailTests` 类末尾追加：

```swift
    /// 两处列表入口：点行必须推详情（NavigationLink），不得再直弹编辑器；
    /// 左滑删除保留；无障碍提示从"编辑"改为"查看"。
    func testListRowsPushDetailInsteadOfEditor() throws {
        let me = try source("Me/MeScreen.swift")
        let myMap = try source("Me/MyMapScreen.swift")

        XCTAssertTrue(me.contains("NavigationLink { FootprintDetailView(footprint:"))
        XCTAssertTrue(myMap.contains("NavigationLink { FootprintDetailView(footprint:"))
        XCTAssertFalse(me.contains("FootprintEditor"))
        XCTAssertFalse(myMap.contains("FootprintEditor"))
        XCTAssertTrue(me.contains(".onDelete"))
        XCTAssertTrue(myMap.contains("查看这段足迹"))
        XCTAssertFalse(myMap.contains("编辑这段足迹"))
    }
```

- [ ] **Step 2: 跑测试确认新用例失败**

Run: `scripts/ios-test.sh`
Expected: 仅 `testListRowsPushDetailInsteadOfEditor` 失败（两处仍直弹编辑器），其余全绿。

- [ ] **Step 3: 改造 MeScreen 最近足迹入口**

`apps/ios/Zhixing/Me/MeScreen.swift` 三处改动：

第 7 行删掉编辑状态：

```swift
    @State private var editingFootprint: Footprint?
```

（整行删除；第 8 行 `deleteError` 保留。）

行点击（47–52 行）把：

```swift
                    ForEach(store.footprints) { fp in
                        Button { editingFootprint = fp } label: {
                            FootprintRow(footprint: fp)
                        }
                        .buttonStyle(.plain)
                    }
```

替换为（`.onDelete` 左滑删除链路不动）：

```swift
                    ForEach(store.footprints) { fp in
                        NavigationLink { FootprintDetailView(footprint: fp) } label: {
                            FootprintRow(footprint: fp)
                        }
                    }
```

编辑 sheet（92 行）整行删除：

```swift
            .sheet(item: $editingFootprint) { fp in FootprintEditor(footprint: fp).appStores() }
```

- [ ] **Step 4: 改造 MyMapScreen 地点足迹入口**

`apps/ios/Zhixing/Me/MyMapScreen.swift` 的 `FootprintPlaceSheet` 三处改动：

删掉编辑状态（约 192 行）：

```swift
    @State private var editingFootprint: Footprint?
```

行点击（约 218–226 行）把：

```swift
                Section("足迹") {
                    ForEach(footprints) { footprint in
                        Button { editingFootprint = footprint } label: {
                            FootprintRow(footprint: footprint)
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint("编辑这段足迹")
                    }
                }
```

替换为（推入发生在 `FootprintPlaceSheet` 自有 NavigationStack 内，sheet 的 medium/large detents 不变）：

```swift
                Section("足迹") {
                    ForEach(footprints) { footprint in
                        NavigationLink { FootprintDetailView(footprint: footprint) } label: {
                            FootprintRow(footprint: footprint)
                        }
                        .accessibilityHint("查看这段足迹")
                    }
                }
```

编辑 sheet（约 237–239 行）整块删除：

```swift
            .sheet(item: $editingFootprint) { footprint in
                FootprintEditor(footprint: footprint).appStores()
            }
```

- [ ] **Step 5: 跑测试确认全绿**

Run: `scripts/ios-test.sh`
Expected: `** TEST SUCCEEDED **`，含新增 3 条用例在内全量通过（`MyMapRegressionTests` 等既有用例不受影响）。

- [ ] **Step 6: 提交**

```bash
git add apps/ios/Zhixing/Me/MeScreen.swift apps/ios/Zhixing/Me/MyMapScreen.swift apps/ios/Tests/FootprintDetailTests.swift
git commit -m "feat(ios): 最近足迹与地点足迹点行改推足迹详情页"
```

---

### Task 4: Mac Catalyst 走查

**Files:** 无代码改动；纯人工验证。

- [ ] **Step 1: 起 Catalyst 环境走查四条路径**

Run: `scripts/mac-dev.sh`（自动起 Postgres/MinIO/开发 API 并构建启动 Catalyst App）

依次确认（用户库里已有"香港 12 张模拟照片"的测试足迹）：
1. **列表 → 详情**：「我的知行 → 最近足迹」点香港足迹行，详情页推入（可返回）：完整正文不截断、12 张照片整宽竖排全部可见、地点/日期/公开徽标如实；已公开足迹显示「获赞 N · 浏览 N」，私密足迹不显示该行。
2. **详情 → 全屏翻页**：点第 3 张照片，全屏浏览器从第 3 张起左右翻页，右上角关闭回详情。
3. **详情 → 编辑回流**：右上「编辑」改正文保存，详情立即显示新正文；再进编辑删除足迹，弹层收起后详情自动退回列表，列表中该足迹消失。
4. **回归**：地点抽屉「旅人镜头」照片墙点格子全屏翻页、「查看故事」仍能拉起故事详情；「我的足迹地图」点 pin 的地点足迹列表点行同样推详情；最近足迹左滑删除仍可用。

Expected: 以上全部符合；有出入即回到对应 Task 修正后重跑测试。
