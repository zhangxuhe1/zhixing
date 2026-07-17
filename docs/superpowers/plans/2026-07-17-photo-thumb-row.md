# 足迹与故事列表宫格封顶 +N 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「最近足迹」（MeScreen）与「旅人故事」（StoriesSection）的 72×72 横滑照片条统一换成共用组件 `ZXPhotoThumbRow`：最多 4 格，溢出时第 4 格盖「+N」遮罩。

**Architecture:** 新增 `Core/ZXPhotoThumbRow.swift`——纯展示 SwiftUI 组件，溢出数字由可单测的静态纯函数 `overflow(total:)` 给出；两处调用点把 `ScrollView(.horizontal)` 照片条整块替换为组件调用。测试 = 纯函数用例 + 源码断言（`InteractionDesignTests` 惯例），防止视觉重构悄悄回退。

**Tech Stack:** SwiftUI（Swift 6，iOS 17+）、XcodeGen、XCTest。设计 spec：`docs/superpowers/specs/2026-07-17-photo-thumb-row-design.md`。

## Global Constraints

- 注释、文档、提交信息一律中文；提交遵循 conventional commits（本计划两个提交均为 `feat(ios): …`）。
- `Zhixing.xcodeproj` 是构建产物，严禁手改；`scripts/ios-test.sh` 自带 `xcodegen generate`，新增源文件后直接跑它即可入工程。
- 测试统一跑 `scripts/ios-test.sh`（真模拟器全量回归）。若报 "Unable to boot device"/"Busy" 类**启动失败**，是模拟器瞬态问题而非测试失败，重跑一次即可。
- 直接提交到 `main`，**不要 push**（用户批量推送）。
- 组件规格是既定设计决策，不得"顺手优化"：72×72、圆角 8、间距 6、封顶 4 格、遮罩 `+N`（N = 总数 − 4）。

---

### Task 1: ZXPhotoThumbRow 组件与溢出纯函数（TDD）

**Files:**
- Create: `apps/ios/Zhixing/Core/ZXPhotoThumbRow.swift`
- Test: `apps/ios/Tests/PhotoThumbRowTests.swift`

**Interfaces:**
- Consumes: `AuthedPhotoView(photoId: String)`（已存在，`Footprint/AuthedPhotoView.swift`：loaded 分支 `scaledToFill`，依赖外部 frame+clip 约束尺寸；失败态自带重试按钮）。
- Produces（Task 2 依赖）: `struct ZXPhotoThumbRow: View`，初始化 `ZXPhotoThumbRow(photoIds: [String])`；`ZXPhotoThumbRow.maxVisible: Int`（= 4）；`ZXPhotoThumbRow.overflow(total: Int) -> Int?`。

- [x] **Step 1: 写失败测试**

新建 `apps/ios/Tests/PhotoThumbRowTests.swift`，完整内容：

```swift
import XCTest
@testable import Zhixing

/// 宫格封顶 +N 缩略行的契约（spec：2026-07-17-photo-thumb-row-design.md）：
/// 遮罩数字 = 没露脸的张数（第 4 格本身是第 4 张照片盖遮罩）；4 张以内不盖遮罩。
final class PhotoThumbRowTests: XCTestCase {
    private func source(_ relativePath: String) throws -> String {
        let testsDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let sourceURL = testsDirectory.deletingLastPathComponent()
            .appendingPathComponent("Zhixing/\(relativePath)")
        return try String(contentsOf: sourceURL, encoding: .utf8)
    }

    func testOverflowAtOrBelowCapShowsNoBadge() {
        XCTAssertNil(ZXPhotoThumbRow.overflow(total: 1))
        XCTAssertNil(ZXPhotoThumbRow.overflow(total: 4))
    }

    func testOverflowAboveCapCountsHiddenPhotos() {
        XCTAssertEqual(ZXPhotoThumbRow.overflow(total: 5), 1)
        XCTAssertEqual(ZXPhotoThumbRow.overflow(total: 12), 8)
    }

    /// 源码断言（InteractionDesignTests 惯例）：锁住 72×72 规格、无横滑、合并朗读。
    func testComponentKeepsTileSpecAndAccessibility() throws {
        let component = try source("Core/ZXPhotoThumbRow.swift")

        XCTAssertTrue(component.contains(".frame(width: 72, height: 72)"))
        XCTAssertTrue(component.contains(".clipShape(RoundedRectangle(cornerRadius: 8))"))
        XCTAssertFalse(component.contains("ScrollView"))
        XCTAssertTrue(component.contains(".accessibilityElement(children: .ignore)"))
        XCTAssertTrue(component.contains("照片，共 \\(photoIds.count) 张"))
    }
}
```

- [x] **Step 2: 跑测试确认失败**

Run: `scripts/ios-test.sh`
Expected: **编译失败**，报 `cannot find 'ZXPhotoThumbRow' in scope`（组件尚不存在，属预期的红灯）。

- [x] **Step 3: 写组件实现**

新建 `apps/ios/Zhixing/Core/ZXPhotoThumbRow.swift`，完整内容：

```swift
import SwiftUI

/// 列表行内的多图缩略：宫格封顶 +N（微博 / X 惯例），取代旧的横滑照片条。
/// 最多渲染 4 张 72×72 缩略图；溢出时最后一格盖遮罩显示「+没露脸的张数」。
/// 好处：总数一眼可知、行高恒定、不与 List 纵向滚动 / 左滑删除抢手势，
/// 且每行图片请求上界从"全部照片"降到 4。
/// 设计：docs/superpowers/specs/2026-07-17-photo-thumb-row-design.md
struct ZXPhotoThumbRow: View {
    let photoIds: [String]

    static let maxVisible = 4

    /// 遮罩数字：总数超过封顶时为"没露脸的张数"（12 张 → +8），否则 nil（不盖遮罩）。
    static func overflow(total: Int) -> Int? {
        total > maxVisible ? total - maxVisible : nil
    }

    var body: some View {
        let visible = Array(photoIds.prefix(Self.maxVisible))
        let overflowCount = Self.overflow(total: photoIds.count)
        HStack(spacing: 6) {
            ForEach(Array(visible.enumerated()), id: \.offset) { index, photoId in
                AuthedPhotoView(photoId: photoId)
                    .frame(width: 72, height: 72)
                    .overlay {
                        if index == visible.count - 1, let overflowCount {
                            ZStack {
                                Color.black.opacity(0.45)
                                Text("+\(overflowCount)")
                                    .font(.system(size: 17, weight: .semibold))
                                    .foregroundStyle(.white)
                            }
                        }
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
        // 逐张朗读只有"图片、图片…"，合并成一条总数信息对 VoiceOver 更有用。
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("照片，共 \(photoIds.count) 张")
    }
}
```

注意 `.overlay` 在 `.clipShape` 之前：遮罩与 `scaledToFill` 的出血一起被圆角裁掉。

- [x] **Step 4: 跑测试确认通过**

Run: `scripts/ios-test.sh`
Expected: `** TEST SUCCEEDED **`，新增 3 条用例全绿，既有用例不受影响。

- [x] **Step 5: 提交**

```bash
git add apps/ios/Zhixing/Core/ZXPhotoThumbRow.swift apps/ios/Tests/PhotoThumbRowTests.swift
git commit -m "feat(ios): 新增宫格封顶 +N 缩略行组件 ZXPhotoThumbRow"
```

---

### Task 2: 替换最近足迹与旅人故事两处照片条

**Files:**
- Modify: `apps/ios/Zhixing/Me/MeScreen.swift`（`FootprintRow.body`，约 186–196 行）
- Modify: `apps/ios/Zhixing/Place/StoriesSection.swift`（故事行照片条，约 197–207 行）
- Test: `apps/ios/Tests/PhotoThumbRowTests.swift`（追加一条用例）

**Interfaces:**
- Consumes: Task 1 的 `ZXPhotoThumbRow(photoIds: [String])`；`Footprint.photos: [FootprintPhotoMeta]` 与 `Story.photos: [StoryPhoto]`（两者元素均有 `id: String`，`StoryPhoto.id` 是 `photoId` 的计算属性——`.map(\.id)` 对两者都成立）。
- Produces: 无新接口；两个列表行的照片区从此只经 `ZXPhotoThumbRow` 渲染。

- [x] **Step 1: 追加失败测试**

在 `PhotoThumbRowTests` 类末尾（`testComponentKeepsTileSpecAndAccessibility` 之后）追加：

```swift
    /// 两个列表行都必须用共用缩略行，不得回退横滑条。
    func testListRowsUseThumbRowInsteadOfHorizontalStrip() throws {
        let me = try source("Me/MeScreen.swift")
        let stories = try source("Place/StoriesSection.swift")

        XCTAssertTrue(me.contains("ZXPhotoThumbRow(photoIds: footprint.photos.map(\\.id))"))
        XCTAssertTrue(stories.contains("ZXPhotoThumbRow(photoIds: story.photos.map(\\.id))"))
        XCTAssertFalse(me.contains("ScrollView(.horizontal"))
        XCTAssertFalse(stories.contains("ScrollView(.horizontal"))
    }
```

- [x] **Step 2: 跑测试确认新用例失败**

Run: `scripts/ios-test.sh`
Expected: 仅 `testListRowsUseThumbRowInsteadOfHorizontalStrip` 失败（两处仍是横滑条），其余全绿。

- [x] **Step 3: 替换 MeScreen 的照片条**

`apps/ios/Zhixing/Me/MeScreen.swift` 中 `FootprintRow.body` 里，把这一块：

```swift
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
```

整块替换为：

```swift
            if !footprint.photos.isEmpty {
                ZXPhotoThumbRow(photoIds: footprint.photos.map(\.id))
            }
```

- [x] **Step 4: 替换 StoriesSection 的照片条**

`apps/ios/Zhixing/Place/StoriesSection.swift` 故事行里，把这一块：

```swift
            if !story.photos.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(story.photos) { photo in
                            AuthedPhotoView(photoId: photo.id)
                                .frame(width: 72, height: 72)
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                    }
                }
            }
```

整块替换为：

```swift
            if !story.photos.isEmpty {
                ZXPhotoThumbRow(photoIds: story.photos.map(\.id))
            }
```

- [x] **Step 5: 跑测试确认全绿**

Run: `scripts/ios-test.sh`
Expected: `** TEST SUCCEEDED **`，含新增 4 条用例在内全量通过。

- [x] **Step 6: 提交**

```bash
git add apps/ios/Zhixing/Me/MeScreen.swift apps/ios/Zhixing/Place/StoriesSection.swift apps/ios/Tests/PhotoThumbRowTests.swift
git commit -m "feat(ios): 最近足迹与旅人故事照片条换用宫格封顶 +N"
```

---

### Task 3: 模拟器走查

**Files:** 无代码改动；纯人工验证。

- [x] **Step 1: 起后端与模拟器跑真实数据走查**

依次确认（用户库里已有"香港 12 张模拟照片"的测试足迹）：
1. 「我的知行 → 最近足迹」：12 张的足迹显示 4 格，第 4 格遮罩「+8」；2 张的足迹（爨底下村）显示 2 格无遮罩。
2. 地点抽屉「旅人故事」：多图故事同样封顶 4 格；点故事行弹 `StoryDetailView`，整宽大图能看到全部照片。
3. 照片区无法再横滑；列表纵向滚动与足迹左滑删除手势正常。
4. 深色模式下遮罩与「+8」白字可读。

Expected: 以上全部符合；有出入即回到对应 Task 修正后重跑测试。
