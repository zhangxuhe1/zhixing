# 详情页照片自适应宫格 ZXPhotoGrid 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增共用照片宫格组件 `ZXPhotoGrid`(1 张题图 / 2 张对分 / ≥3 三列宫格),替换足迹详情与公开故事详情的整宽横幅照片区,根治宽窗口下的裁切与长滚动;公开故事详情连带接上 `ZXPhotoBrowser` 全屏浏览。

**Architecture:** 纯 iOS 改动(apps/ios),服务端/管理端/API 零改动。新组件落 `Core/`,档位选择抽 `nonisolated static` 纯函数供单测;方格裁切复用 `PhotoWallSection.photoCell` 踩坑后的 `Color.clear` 定框写法;两个详情页只换照片区,全屏浏览用现成 `ZXPhotoBrowser`。

**Tech Stack:** SwiftUI(Swift 6 / iOS 17+)、XcodeGen、XCTest(源码断言惯例)。

**Spec:** `docs/superpowers/specs/2026-07-17-photo-grid-design.md`

## Global Constraints

- 只动 `apps/ios`;不新增任何 API、不改服务端/管理端。
- 注释与 commit message 用中文,conventional commits(`feat(ios): ...`)。
- 组件源码不得出现具体业务文案(不得含「足迹」「故事」字样,同 `ZXPhotoBrowser` 约定)。
- 图片格子身份必须绑照片 id(`ForEach(..., id: \.element)`),不得按位置(`\.offset`)——`AuthedPhotoView` 的 `@State` 缓存跟随视图身份。
- 方格/定比裁切必须用 `Color.clear` 定框 + 图作 overlay + clip 的写法(`PhotoWallSection.swift:93-100` 注释),不得直接对 `AuthedPhotoView` 用 `.aspectRatio`。
- 规格数值:单张 4:3 圆角 18;双张与宫格格子 1:1 圆角 8;间距 4;宫格三列。
- `Zhixing.xcodeproj` 是构建产物,永不手改;新文件靠 `xcodegen generate` 入工程(`scripts/ios-test.sh` 已内置)。
- 模拟器偶发 Busy 瞬态启动失败不是测试失败,重跑即过。

---

### Task 1: ZXPhotoGrid 组件 + 档位纯函数(TDD)

**Files:**
- Create: `apps/ios/Zhixing/Core/ZXPhotoGrid.swift`
- Create: `apps/ios/Tests/PhotoGridTests.swift`

**Interfaces:**
- Consumes: `AuthedPhotoView(photoId: String)`(现有,`Footprint/AuthedPhotoView.swift`,loaded 分支为 `scaledToFill`)。
- Produces: `struct ZXPhotoGrid: View`,init 参数 `photoIds: [String]`、`onTap: (Int) -> Void`(参数为被点格子下标);`enum Layout { case single, pair, grid }`;`nonisolated static func layout(for count: Int) -> Layout`。Task 2/3 靠这两个签名接入。

- [ ] **Step 1: 写失败测试**

新建 `apps/ios/Tests/PhotoGridTests.swift`:

```swift
import XCTest
@testable import Zhixing

/// 详情页照片自适应宫格的契约（spec：2026-07-17-photo-grid-design.md）：
/// 1 张=整宽 4:3 题图、2 张=两格对分、≥3 张=三列宫格；两个详情页共用组件，
/// 整宽横幅（minHeight: 220 + scaledToFill 裁切）不复存在。
final class PhotoGridTests: XCTestCase {
    private func source(_ relativePath: String) throws -> String {
        let testsDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let sourceURL = testsDirectory.deletingLastPathComponent()
            .appendingPathComponent("Zhixing/\(relativePath)")
        return try String(contentsOf: sourceURL, encoding: .utf8)
    }

    func testLayoutTiers() {
        XCTAssertEqual(ZXPhotoGrid.layout(for: 1), .single)
        XCTAssertEqual(ZXPhotoGrid.layout(for: 2), .pair)
        XCTAssertEqual(ZXPhotoGrid.layout(for: 3), .grid)
        XCTAssertEqual(ZXPhotoGrid.layout(for: 4), .grid)
        XCTAssertEqual(ZXPhotoGrid.layout(for: 12), .grid)
    }

    /// 源码断言（InteractionDesignTests 惯例）：定框裁切必须用 Color.clear 写法、
    /// 格子身份绑照片 id、组件不含业务文案。
    func testComponentKeepsClippingAndIdentityGuardrails() throws {
        let component = try source("Core/ZXPhotoGrid.swift")

        XCTAssertTrue(component.contains("Color.clear"))
        XCTAssertTrue(component.contains(".aspectRatio("))
        XCTAssertTrue(component.contains("id: \\.element"))
        XCTAssertFalse(component.contains("id: \\.offset"))
        XCTAssertFalse(component.contains("足迹"))
        XCTAssertFalse(component.contains("故事"))
    }
}
```

- [ ] **Step 2: 跑测试确认失败**

```sh
cd apps/ios && xcodegen generate && SIM=$(xcrun simctl list devices available | grep -oE "iPhone [^(]+" | head -1 | xargs) && xcodebuild -project Zhixing.xcodeproj -scheme Zhixing -destination "platform=iOS Simulator,name=$SIM" test -only-testing:ZhixingTests/PhotoGridTests
```

预期:**编译失败**,`cannot find 'ZXPhotoGrid' in scope`(源码断言那条此刻也必然红——组件文件还不存在)。

- [ ] **Step 3: 实现组件**

新建 `apps/ios/Zhixing/Core/ZXPhotoGrid.swift`:

```swift
import SwiftUI

/// 详情页照片区的自适应宫格，取代整宽横幅竖排——横幅在宽窗口下是约 2.6:1 的宽扁框
/// + scaledToFill，方图/竖图只剩中间一条横带，且每张独占约 300pt 纵向空间。
/// 按张数三档：1 张=整宽 4:3 题图、2 张=两格 1:1 对分、≥3 张=三列 1:1 宫格。
/// 点格子回调下标，全屏浏览由调用方接 ZXPhotoBrowser（组件不含业务文案，PhotoGridTests 有断言）。
/// 设计：docs/superpowers/specs/2026-07-17-photo-grid-design.md
struct ZXPhotoGrid: View {
    let photoIds: [String]
    let onTap: (Int) -> Void

    /// 档位：1 张题图 / 2 张对分 / ≥3 张宫格。
    enum Layout { case single, pair, grid }

    /// `nonisolated` 纯函数（同 `ZXPhotoThumbRow.overflow` 惯例）；
    /// 0 张由 body 的空视图分支短路，本函数只需对 ≥1 有定义。
    nonisolated static func layout(for count: Int) -> Layout {
        switch count {
        case 1: .single
        case 2: .pair
        default: .grid
        }
    }

    private let columns = Array(repeating: GridItem(.flexible(), spacing: 4), count: 3)

    var body: some View {
        if photoIds.isEmpty {
            EmptyView()
        } else {
            switch Self.layout(for: photoIds.count) {
            case .single:
                // 单张无 ForEach，显式 .id 绑照片 id，语义与下方 id: \.element 一致。
                tile(index: 0, aspect: 4.0 / 3.0, cornerRadius: 18)
                    .id(photoIds[0])
            case .pair:
                HStack(spacing: 4) {
                    ForEach(Array(photoIds.enumerated()), id: \.element) { index, _ in
                        tile(index: index, aspect: 1, cornerRadius: 8)
                    }
                }
            case .grid:
                LazyVGrid(columns: columns, spacing: 4) {
                    // 格子身份绑照片 id 而非位置：AuthedPhotoView 的 @State 图片缓存跟随视图身份，
                    // 按位置认身份会在照片删除/重排后让存活位置继续显示旧图（同 ZXPhotoThumbRow 护栏）。
                    ForEach(Array(photoIds.enumerated()), id: \.element) { index, _ in
                        tile(index: index, aspect: 1, cornerRadius: 8)
                    }
                }
            }
        }
    }

    /// 定框裁切的尺寸权威必须是外框而非 AuthedPhotoView 自身（PhotoWallSection.photoCell 踩坑注释）：
    /// 其 loaded 分支是 scaledToFill，直接 .aspectRatio(_, .fit) 只变换提案、上报的仍是子视图的
    /// 覆盖尺寸；Color.clear 按提案定框，图作 overlay，溢出部分才真正被 clip 掉。
    private func tile(index: Int, aspect: CGFloat, cornerRadius: CGFloat) -> some View {
        Button { onTap(index) } label: {
            Color.clear
                .aspectRatio(aspect, contentMode: .fit)
                .overlay { AuthedPhotoView(photoId: photoIds[index]) }
                .clipShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel("第 \(index + 1) 张照片，共 \(photoIds.count) 张，点按全屏查看")
    }
}
```

- [ ] **Step 4: 跑测试确认通过**

用 Step 2 同一条命令。预期:`Test Suite 'PhotoGridTests' passed`,2 条用例全绿。

- [ ] **Step 5: 提交**

```sh
git add apps/ios/Zhixing/Core/ZXPhotoGrid.swift apps/ios/Tests/PhotoGridTests.swift
git commit -m "feat(ios): 新增详情页照片自适应宫格组件 ZXPhotoGrid"
```

---

### Task 2: 足迹详情页换装宫格

**Files:**
- Modify: `apps/ios/Zhixing/Footprint/FootprintDetailView.swift:58-67`
- Modify: `apps/ios/Tests/PhotoGridTests.swift`(追加 1 条用例)

**Interfaces:**
- Consumes: `ZXPhotoGrid(photoIds: [String], onTap: (Int) -> Void)`(Task 1);现有 `BrowseStart`/`browseStart`/`ZXPhotoBrowser` 链路不动。
- Produces: 无新接口;`FootprintDetailView` 照片区形态变更。

- [ ] **Step 1: 追加失败测试**

在 `PhotoGridTests` 类内(`testComponentKeepsClippingAndIdentityGuardrails` 之后)追加:

```swift
    /// 足迹详情必须用共用宫格，整宽横幅写法（minHeight: 220）不得回潮。
    func testFootprintDetailUsesGridInsteadOfBanner() throws {
        let detail = try source("Footprint/FootprintDetailView.swift")

        XCTAssertTrue(detail.contains("ZXPhotoGrid(photoIds: current.photos.map(\\.id))"))
        XCTAssertFalse(detail.contains("minHeight: 220"))
    }
```

- [ ] **Step 2: 跑测试确认失败**

```sh
cd apps/ios && xcodegen generate && SIM=$(xcrun simctl list devices available | grep -oE "iPhone [^(]+" | head -1 | xargs) && xcodebuild -project Zhixing.xcodeproj -scheme Zhixing -destination "platform=iOS Simulator,name=$SIM" test -only-testing:ZhixingTests/PhotoGridTests
```

预期:`testFootprintDetailUsesGridInsteadOfBanner` FAIL(详情页还没引用 ZXPhotoGrid),其余 2 条 PASS。

- [ ] **Step 3: 换装**

`FootprintDetailView.swift` 中,将照片区整块(含身份注释):

```swift
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
```

整体替换为:

```swift
                    ZXPhotoGrid(photoIds: current.photos.map(\.id)) { browseStart = BrowseStart(index: $0) }
```

其余(`BrowseStart`、`fullScreenCover`、编辑/删除退栈)零改动。

- [ ] **Step 4: 跑测试确认通过(含既有契约不破)**

```sh
cd apps/ios && xcodegen generate && SIM=$(xcrun simctl list devices available | grep -oE "iPhone [^(]+" | head -1 | xargs) && xcodebuild -project Zhixing.xcodeproj -scheme Zhixing -destination "platform=iOS Simulator,name=$SIM" test -only-testing:ZhixingTests/PhotoGridTests -only-testing:ZhixingTests/FootprintDetailTests
```

预期:PhotoGridTests 3 条 + FootprintDetailTests 3 条全绿(后者锁的 `ZXPhotoBrowser(`/`.fullScreenCover`/`获赞`/`.appStores()` 等契约全部保留)。

- [ ] **Step 5: 提交**

```sh
git add apps/ios/Zhixing/Footprint/FootprintDetailView.swift apps/ios/Tests/PhotoGridTests.swift
git commit -m "feat(ios): 足迹详情照片区整宽横幅换自适应宫格"
```

---

### Task 3: 公开故事详情换装宫格 + 接全屏浏览

**Files:**
- Modify: `apps/ios/Zhixing/Place/StoryDetailView.swift`
- Modify: `apps/ios/Tests/PhotoGridTests.swift`(追加 1 条用例)

**Interfaces:**
- Consumes: `ZXPhotoGrid(photoIds:onTap:)`(Task 1);`ZXPhotoBrowser(photoIds: [String], startIndex: Int, onClose: () -> Void)` 无底栏便捷构造(现有,`Core/ZXPhotoBrowser.swift:57-60`);`.appStores()`(现有,`Core/AppStores.swift`)。
- Produces: 无新接口;公开故事详情新增点图全屏能力。

- [ ] **Step 1: 追加失败测试**

在 `PhotoGridTests` 类内追加:

```swift
    /// 公开故事详情：宫格 + 点图全屏（fullScreenCover + appStores 惯例——Catalyst modal
    /// 宿主不继承环境），整宽横幅不得回潮。
    func testStoryDetailUsesGridAndFullScreenBrowser() throws {
        let story = try source("Place/StoryDetailView.swift")

        XCTAssertTrue(story.contains("ZXPhotoGrid(photoIds: story.photos.map(\\.photoId))"))
        XCTAssertTrue(story.contains("ZXPhotoBrowser("))
        XCTAssertTrue(story.contains(".fullScreenCover"))
        XCTAssertTrue(story.contains(".appStores()"))
        XCTAssertFalse(story.contains("minHeight: 220"))
    }
```

- [ ] **Step 2: 跑测试确认失败**

```sh
cd apps/ios && xcodegen generate && SIM=$(xcrun simctl list devices available | grep -oE "iPhone [^(]+" | head -1 | xargs) && xcodebuild -project Zhixing.xcodeproj -scheme Zhixing -destination "platform=iOS Simulator,name=$SIM" test -only-testing:ZhixingTests/PhotoGridTests
```

预期:`testStoryDetailUsesGridAndFullScreenBrowser` FAIL,其余 3 条 PASS。

- [ ] **Step 3: 改 StoryDetailView**

`StoryDetailView.swift` 三处改动:

① 状态区(`likeErrorToken` 之后)追加一行:

```swift
    @State private var browseStart: BrowseStart?
```

② 照片区整块:

```swift
                        ForEach(story.photos) { photo in
                            AuthedPhotoView(photoId: photo.id)
                                .frame(maxWidth: .infinity, minHeight: 220, maxHeight: 280)
                                    .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                        }
```

整体替换为:

```swift
                        ZXPhotoGrid(photoIds: story.photos.map(\.photoId)) { browseStart = BrowseStart(index: $0) }
```

③ 内层 `ZStack`(`ZXTheme.canvas` + ScrollView 那个)的右花括号后挂 fullScreenCover——story 在 LoadStateView 内容闭包里天然在作用域内:

```swift
                }
                .fullScreenCover(item: $browseStart) { start in
                    ZXPhotoBrowser(
                        photoIds: story.photos.map(\.photoId), startIndex: start.index,
                        onClose: { browseStart = nil })
                        .appStores()
                }
```

④ 类型底部(`toggleLike` 之后)追加装箱结构体:

```swift
    /// 全屏浏览起点：下标装箱成 Identifiable 供 .fullScreenCover(item:) 使用
    ///（同 FootprintDetailView.BrowseStart）。
    private struct BrowseStart: Identifiable {
        let index: Int
        var id: Int { index }
    }
```

- [ ] **Step 4: 跑测试确认通过**

用 Step 2 同一条命令。预期:PhotoGridTests 4 条全绿。

- [ ] **Step 5: 提交**

```sh
git add apps/ios/Zhixing/Place/StoryDetailView.swift apps/ios/Tests/PhotoGridTests.swift
git commit -m "feat(ios): 公开故事详情照片区换宫格并接全屏浏览"
```

---

### Task 4: 全量回归 + Mac Catalyst 走查

**Files:**
- 无代码改动(除非走查发现问题,修复按 `fix(ios): ...` 单独提交)

**Interfaces:**
- Consumes: Task 1-3 全部产物。
- Produces: 验收结论。

- [ ] **Step 1: iOS 全量回归**

```sh
scripts/ios-test.sh
```

预期:全部测试套件 PASS(含既有 `FootprintDetailTests`、`PhotoThumbRowTests`、`InteractionDesignTests` 等)。模拟器偶发 Busy 瞬态启动失败不是测试失败,重跑一次即过。

- [ ] **Step 2: 起 Mac Catalyst 端**

先清场再启动(mac-dev.sh 只自杀同路径旧实例,`open -n` 会双开):

```sh
pgrep -fl Zhixing || true   # 有旧实例先 kill
scripts/mac-dev.sh
```

- [ ] **Step 3: 走查三档布局与全屏起点**

- 「我的」→ 最近足迹 → 香港 12 张测试足迹 → 详情:照片区应为三列宫格 4 行(约一屏看全,不再是 12 块整宽横幅);点第 5 格 → 全屏浏览器应从第 5 张起翻页。
- 在最近足迹里找一条 1 张照片、一条 2 张照片的足迹分别进详情:单张应为整宽 4:3 圆角 18 题图,双张应为两格 1:1 对分。若列表里没有这两种张数的足迹,用「导入」流程从相册选 1 张 / 2 张各造一条再走查。
- 地图 → 任一地点 → 旅人故事 → 进公开故事详情:照片区为宫格;点任意格全屏翻页可开可关(此页此前完全不可点图)。
- 截图纪律:只截知行窗口,不得全屏截图;窗口截图失败先报告。

- [ ] **Step 4: 收尾确认**

```sh
git status --short   # 预期无未提交改动
git log --oneline -4 # 预期 Task 1-3 三个 feat(ios) 提交在列
```
