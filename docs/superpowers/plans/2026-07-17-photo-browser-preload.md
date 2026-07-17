# 看图页邻页预载 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 全屏看图页(`ZXPhotoBrowser`)加会话级邻页预载,翻页永远"图换图"瞬切,消灭黑屏空窗;顺带把看图页解码从全分辨率改为按屏降采样。

**Architecture:** 新增自持加载器 `ZXBrowserPhotoLoader`(@MainActor @Observable,看图页 @State 持有):`focus(index)` 按优先级窗口 [i, i+1, i-1, i+2, i-2] 预拉缺失照片(presign→下载→ImageIO 降采样解码),窗口外缓存淘汰、在途任务取消,内存上限即窗口 5 张;取数闭包注入使逻辑可无网络单测。看图页页视图改为从 loader 读图,`AuthedPhotoView` 与其他使用面零改动。

**Tech Stack:** SwiftUI + Swift 6(strict)、@Observable(iOS 17+)、ImageIO 降采样(复用既有 `downsampledImage`)、XCTest。

**Spec:** docs/superpowers/specs/2026-07-17-photo-browser-preload-design.md

## Global Constraints

- Swift 6 strict + iOS 17 deployment target,iOS 与 Mac Catalyst 双目标;新文件落 `apps/ios/Zhixing/Core/` 后由 XcodeGen 按目录收编(`scripts/ios-test.sh` 内含 `xcodegen generate`)。
- 注释、文档、提交信息中文;conventional commits(`feat(ios): ...`)。
- 私密照片仅内存缓存、不落磁盘(规格书 §5.1;网络走 `APIClient.photoSession` ephemeral)。
- 看图页两条既有护栏不得回退:按钮翻页无动画瞬切;页尺寸权威 `Color.clear` + overlay + `.clipped()`(`FootprintDetailTests.testBrowserPagesSizedByProposalAndFlipWithoutAnimation` 把关,Task 2 会同步更新其断言)。
- 图就位时的替换同样无动画(纯瞬切口味,用户拍板)。

---

### Task 1: `ZXBrowserPhotoLoader`(窗口纯函数 + 加载器)与单元测试

**Files:**
- Create: `apps/ios/Zhixing/Core/ZXBrowserPhotoLoader.swift`
- Test: `apps/ios/Tests/BrowserPhotoLoaderTests.swift`

**Interfaces:**
- Consumes: 既有全局函数 `downsampledImage(from: Data, maxPixelSize: CGFloat) -> UIImage?`(`Me/TripShareScreen.swift`)、`APIClient.shared.get(_:)`、`APIClient.photoSession`、`PhotoURL`。
- Produces(Task 2 依赖的确切签名):
  - `final class ZXBrowserPhotoLoader`(@MainActor @Observable);
  - `nonisolated init(photoIds: [String], fetch: @escaping @Sendable (String) async throws -> Data = ZXBrowserPhotoLoader.defaultFetch, maxPixelSize: CGFloat = 0)`(0 = 首次加载时按主屏推导);
  - `private(set) var images: [String: UIImage]`、`private(set) var failed: Set<String>`;
  - `func focus(_ index: Int)`、`func retry(_ photoId: String)`;
  - `nonisolated static func prefetchWindow(around index: Int, count: Int) -> [Int]`。

- [ ] **Step 1: 写失败测试**

`apps/ios/Tests/BrowserPhotoLoaderTests.swift` 全文:

```swift
import XCTest
@testable import Zhixing

/// 看图页邻页预载加载器(spec:2026-07-17-photo-browser-preload-design.md):
/// 窗口纯函数、只拉窗口内缺失项、在途去重、窗口滑动淘汰、失败进 failed、retry 重拉。
final class BrowserPhotoLoaderTests: XCTestCase {
    /// 记录 fetch 调用的线程安全日志;可按 id 定制失败与延迟。
    private actor FetchLog {
        private(set) var ids: [String] = []
        var failingIds: Set<String> = []
        func record(_ id: String) { ids.append(id) }
        func setFailing(_ ids: Set<String>) { failingIds = ids }
    }

    /// 4×4 红色 PNG:足够小、可被 downsampledImage 解码。
    private static let tinyPNG: Data = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4))
        .pngData { ctx in
            UIColor.red.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: 4, height: 4))
        }

    private static func ids(_ n: Int) -> [String] { (0..<n).map { "p\($0)" } }

    @MainActor
    private func waitUntil(
        _ what: String, timeoutMs: Int = 2000, _ condition: () -> Bool
    ) async {
        for _ in 0..<(timeoutMs / 10) {
            if condition() { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("等待超时:\(what)")
    }

    private func makeLoader(
        count: Int, log: FetchLog, delayMs: Int = 0
    ) -> ZXBrowserPhotoLoader {
        ZXBrowserPhotoLoader(
            photoIds: Self.ids(count),
            fetch: { id in
                await log.record(id)
                if delayMs > 0 { try? await Task.sleep(for: .milliseconds(delayMs)) }
                if await log.failingIds.contains(id) { throw URLError(.timedOut) }
                return Self.tinyPNG
            },
            maxPixelSize: 64)
    }

    func testPrefetchWindowOrdersNeighborsByPriority() {
        XCTAssertEqual(ZXBrowserPhotoLoader.prefetchWindow(around: 5, count: 12), [5, 6, 4, 7, 3])
        XCTAssertEqual(ZXBrowserPhotoLoader.prefetchWindow(around: 0, count: 12), [0, 1, 2])
        XCTAssertEqual(ZXBrowserPhotoLoader.prefetchWindow(around: 11, count: 12), [11, 10, 9])
        XCTAssertEqual(ZXBrowserPhotoLoader.prefetchWindow(around: 1, count: 3), [1, 2, 0])
        XCTAssertEqual(ZXBrowserPhotoLoader.prefetchWindow(around: 0, count: 1), [0])
        XCTAssertEqual(ZXBrowserPhotoLoader.prefetchWindow(around: 9, count: 0), [])
        // 越界 index 先夹回合法区间再展开窗口
        XCTAssertEqual(ZXBrowserPhotoLoader.prefetchWindow(around: 99, count: 3), [2, 1, 0])
    }

    @MainActor
    func testFocusLoadsOnlyWindowAndDedupesInflight() async {
        let log = FetchLog()
        let loader = makeLoader(count: 12, log: log, delayMs: 50)
        loader.focus(5)
        loader.focus(5) // 在途去重:第二次 focus 不得重复起拉
        await waitUntil("窗口 5 张就位") { loader.images.count == 5 }
        let fetched = await log.ids
        XCTAssertEqual(Set(fetched), Set(["p3", "p4", "p5", "p6", "p7"]))
        XCTAssertEqual(fetched.count, 5)
        XCTAssertEqual(Set(loader.images.keys), Set(["p3", "p4", "p5", "p6", "p7"]))
        XCTAssertTrue(loader.failed.isEmpty)
    }

    @MainActor
    func testWindowSlideEvictsOutOfWindowImages() async {
        let log = FetchLog()
        let loader = makeLoader(count: 12, log: log)
        loader.focus(0)
        await waitUntil("首窗就位") { loader.images.count == 3 }
        loader.focus(8)
        await waitUntil("新窗就位") { Set(loader.images.keys) == Set(["p6", "p7", "p8", "p9", "p10"]) }
        XCTAssertNil(loader.images["p0"]) // 滑窗后旧页必须淘汰,缓存上限=窗口
    }

    @MainActor
    func testFailureMarksFailedAndRetryRecovers() async {
        let log = FetchLog()
        await log.setFailing(["p1"])
        let loader = makeLoader(count: 3, log: log)
        loader.focus(0)
        await waitUntil("失败页记入 failed") { loader.failed.contains("p1") }
        XCTAssertNil(loader.images["p1"])
        XCTAssertNotNil(loader.images["p0"]) // 单张失败不拖累邻页
        await log.setFailing([])
        loader.retry("p1")
        await waitUntil("retry 后恢复") { loader.images["p1"] != nil }
        XCTAssertFalse(loader.failed.contains("p1"))
    }

    @MainActor
    func testUndecodableBytesMarkFailed() async {
        let log = FetchLog()
        let loader = ZXBrowserPhotoLoader(
            photoIds: Self.ids(1),
            fetch: { _ in Data([0x00, 0x01]) }, // 解不出图的字节
            maxPixelSize: 64)
        _ = log
        loader.focus(0)
        await waitUntil("坏字节进 failed") { loader.failed.contains("p0") }
    }
}
```

- [ ] **Step 2: 跑测试确认失败(类型不存在)**

Run: `cd apps/ios && xcodegen generate && SIM=$(xcrun simctl list devices available | grep -oE "iPhone [^(]+" | head -1 | xargs) && xcodebuild -project Zhixing.xcodeproj -scheme Zhixing -destination "platform=iOS Simulator,name=$SIM" test 2>&1 | tail -20`
Expected: BUILD FAILED,报 `cannot find 'ZXBrowserPhotoLoader' in scope`。

- [ ] **Step 3: 实现 `ZXBrowserPhotoLoader`**

`apps/ios/Zhixing/Core/ZXBrowserPhotoLoader.swift` 全文:

```swift
import SwiftUI
import UIKit

/// 看图页会话级照片加载器:邻页预载 + 内存内降采样缓存,让翻页永远"图换图"瞬切
///(对标 Preview/Photos 的预解码机制)。窗口 [i, i±1, i±2]、缓存上限即窗口大小,
/// 窗口外淘汰、在途取消;仅内存、不落盘(私密照片约束,规格书 §5.1),随看图页
/// @State 释放。取数闭包注入,逻辑可无网络单测(BrowserPhotoLoaderTests)。
/// 设计:docs/superpowers/specs/2026-07-17-photo-browser-preload-design.md
@MainActor @Observable
final class ZXBrowserPhotoLoader {
    private(set) var images: [String: UIImage] = [:]
    private(set) var failed: Set<String> = []
    private var inflight: [String: Task<Void, Never>] = [:]

    private let photoIds: [String]
    private let fetch: @Sendable (String) async throws -> Data
    /// 0 = 首次加载时按主屏推导(nonisolated init 里够不到 UIScreen)。
    private let maxPixelSizeOverride: CGFloat

    nonisolated init(
        photoIds: [String],
        fetch: @escaping @Sendable (String) async throws -> Data = ZXBrowserPhotoLoader.defaultFetch,
        maxPixelSize: CGFloat = 0
    ) {
        self.photoIds = photoIds
        self.fetch = fetch
        self.maxPixelSizeOverride = maxPixelSize
    }

    /// 预载优先级序:[i, i+1, i-1, i+2, i-2] 截断越界(先夹 index 再展开);纯函数可单测。
    nonisolated static func prefetchWindow(around index: Int, count: Int) -> [Int] {
        guard count > 0 else { return [] }
        let clamped = min(max(index, 0), count - 1)
        return [clamped, clamped + 1, clamped - 1, clamped + 2, clamped - 2]
            .filter { (0..<count).contains($0) }
    }

    /// 翻到第 index 页:补齐窗口内缺失项;窗口外缓存淘汰、在途取消(缓存上限=窗口)。
    func focus(_ index: Int) {
        let window = Self.prefetchWindow(around: index, count: photoIds.count)
        let wanted = Set(window.map { photoIds[$0] })
        for id in images.keys where !wanted.contains(id) { images[id] = nil }
        for (id, task) in inflight where !wanted.contains(id) {
            task.cancel()
            inflight[id] = nil
        }
        for i in window { load(photoIds[i]) }
    }

    /// 失败页重试入口(页内重试按钮调用)。
    func retry(_ photoId: String) {
        failed.remove(photoId)
        load(photoId)
    }

    private func load(_ photoId: String) {
        guard images[photoId] == nil, inflight[photoId] == nil, !failed.contains(photoId) else { return }
        let fetch = self.fetch
        let maxPixelSize = maxPixelSizeOverride > 0 ? maxPixelSizeOverride : Self.screenMaxPixelSize()
        inflight[photoId] = Task {
            var image: UIImage?
            do {
                let data = try await fetch(photoId)
                // 降采样解码丢后台:全程不产生原始分辨率位图,也不在主线程扎堆
                image = await Task.detached(priority: .userInitiated) {
                    downsampledImage(from: data, maxPixelSize: maxPixelSize)
                }.value
            } catch {
                image = nil
            }
            inflight[photoId] = nil
            // 滑窗取消的任务不得把人家误记失败
            guard !Task.isCancelled else { return }
            if let image {
                images[photoId] = image
            } else {
                failed.insert(photoId)
            }
        }
    }

    /// 默认取数:presign 换短时 URL 再取字节,与 AuthedPhotoView 同链路,不落磁盘缓存。
    nonisolated static func defaultFetch(_ photoId: String) async throws -> Data {
        let signed: PhotoURL = try await APIClient.shared.get("/photos/\(photoId)")
        guard let url = URL(string: signed.url) else { throw URLError(.badURL) }
        let (data, _) = try await APIClient.photoSession.data(from: url)
        return data
    }

    /// 解码目标:主屏长边×scale,夹在 [2048, 4096]——上限防 5K 全屏内存失控,下限保常规窗口清晰。
    private static func screenMaxPixelSize() -> CGFloat {
        let bounds = UIScreen.main.bounds
        let longest = max(bounds.width, bounds.height) * UIScreen.main.scale
        return min(max(longest, 2048), 4096)
    }
}
```

- [ ] **Step 4: 跑测试确认全绿**

Run: `scripts/ios-test.sh 2>&1 | grep -E "Test Suite 'All tests'|Executed|TEST" | tail -3`
Expected: `** TEST SUCCEEDED **`,总数比上轮多 6(BrowserPhotoLoaderTests 全过)。

- [ ] **Step 5: 提交**

```bash
git add apps/ios/Zhixing/Core/ZXBrowserPhotoLoader.swift apps/ios/Tests/BrowserPhotoLoaderTests.swift
git commit -m "feat(ios): 看图页照片加载器——邻页预载窗口/降采样解码/失败重试"
```

---

### Task 2: 看图页接入 loader,契约测试同步

**Files:**
- Modify: `apps/ios/Zhixing/Core/ZXPhotoBrowser.swift`
- Modify: `apps/ios/Tests/FootprintDetailTests.swift`(`testBrowserPagesSizedByProposalAndFlipWithoutAnimation`)

**Interfaces:**
- Consumes: Task 1 的 `ZXBrowserPhotoLoader`(`nonisolated init(photoIds:fetch:maxPixelSize:)` 带默认参、`images`、`failed`、`focus(_:)`、`retry(_:)`)。
- Produces: 看图页不再引用 `AuthedPhotoView`;页视图私有函数 `pagePhoto(_ photoId: String) -> some View`。

- [ ] **Step 1: 先改契约测试(预期失败)**

`FootprintDetailTests.swift` 中 `testBrowserPagesSizedByProposalAndFlipWithoutAnimation` 整个函数替换为:

```swift
    /// 分页三护栏(几何探针实证,勿回退):
    /// 1)页尺寸权威是 Color.clear + overlay + clipped——scaledToFill 上报覆盖尺寸,
    ///    maxi frame 会把页撑得比分页视口宽、溢出压进邻页("一屏各显示两张图一部分");
    /// 2)按钮翻页无动画瞬切——withAnimation 驱动 selection 与分页落页写回竞态,
    ///    连点漂移/过冲、被打断的过渡停在非整页位置;
    /// 3)页照片必须走 ZXBrowserPhotoLoader 预载(spec:photo-browser-preload)——
    ///    直接用 AuthedPhotoView 会退回"翻到才加载"的黑屏空窗。
    func testBrowserPagesSizedByProposalAndFlipWithoutAnimation() throws {
        let browser = try source("Core/ZXPhotoBrowser.swift")

        XCTAssertTrue(browser.contains(".overlay { pagePhoto(photoId) }"))
        XCTAssertTrue(browser.contains("ZXBrowserPhotoLoader"))
        XCTAssertTrue(browser.contains("loader.focus(selection)"))
        XCTAssertFalse(browser.contains("AuthedPhotoView"))
        XCTAssertTrue(browser.contains("selection -= 1") && browser.contains("selection += 1"))
        XCTAssertFalse(browser.contains("withAnimation(.easeInOut(duration: 0.2)) { selection"))
    }
```

- [ ] **Step 2: 跑该测试确认失败**

Run: `cd apps/ios && xcodegen generate && SIM=$(xcrun simctl list devices available | grep -oE "iPhone [^(]+" | head -1 | xargs) && xcodebuild -project Zhixing.xcodeproj -scheme Zhixing -destination "platform=iOS Simulator,name=$SIM" test -only-testing:ZhixingTests/FootprintDetailTests 2>&1 | grep -E "Test Case.*(passed|failed)" | tail -8`
Expected: `testBrowserPagesSizedByProposalAndFlipWithoutAnimation` failed(源码尚未接 loader),其余仍 passed。

- [ ] **Step 3: 看图页接入 loader**

`ZXPhotoBrowser.swift` 逐处修改:

3a. 状态区(`@State private var hoverClose = false` 之后)加:

```swift
    // 邻页预载加载器:随看图页生命周期,关闭即整体释放(内存缓存不落盘)
    @State private var loader: ZXBrowserPhotoLoader
```

3b. `init` 里 `_selection = State(initialValue: startIndex)` 之后加:

```swift
        _loader = State(initialValue: ZXBrowserPhotoLoader(photoIds: photoIds))
```

3c. `body` 的 `.task { ... }`(开场亮相那个)之后追加:

```swift
            .task { loader.focus(selection) }
            .onChange(of: selection) { loader.focus(selection) }
```

3d. `core` 里 ForEach 的页内容从:

```swift
                ForEach(Array(photoIds.enumerated()), id: \.element) { index, photoId in
                    Color.clear
                        .overlay { AuthedPhotoView(photoId: photoId) }
                        .clipped()
                        .tag(index)
                }
```

改为(注释同步更新第三条护栏):

```swift
                ForEach(Array(photoIds.enumerated()), id: \.element) { index, photoId in
                    Color.clear
                        .overlay { pagePhoto(photoId) }
                        .clipped()
                        .tag(index)
                }
```

并同步改 ForEach 上方两段注释(源码中不得残留 `AuthedPhotoView` 字样,契约测试把关):
- "页身份绑照片 id"段改为:`// 页身份绑照片 id(tag 用下标翻页);photoIds 在浏览会话内不变。`(@State 缓存跟随身份的理由已随 loader 化失效);
- "页尺寸权威"段里 `AuthedPhotoView loaded 分支` 表述改为 `pagePhoto 已载分支`(护栏语义不变)。

3e. `core` 属性之后新增页视图(占位/失败样式与 `AuthedPhotoView` 同语言;图就位替换无动画,纯瞬切口味):

```swift
    /// 页照片三态:已载(loader 预解码,翻页即"图换图")/ 在途占位 / 失败可重试。
    /// 占位与失败样式沿用私密照片视图的既有语言,但数据一律走 loader——
    /// 绕开 loader 直连旧照片视图会退回"翻到才加载"的空窗(契约测试把关)。
    @ViewBuilder private func pagePhoto(_ photoId: String) -> some View {
        if let image = loader.images[photoId] {
            Image(uiImage: image).resizable().scaledToFill()
        } else if loader.failed.contains(photoId) {
            Button { loader.retry(photoId) } label: {
                Rectangle().fill(.quaternary)
                    .overlay(Image(systemName: "arrow.clockwise").foregroundStyle(.secondary))
            }
            .buttonStyle(.plain)
        } else {
            Rectangle().fill(.quaternary).overlay(ProgressView().controlSize(.small))
        }
    }
```

- [ ] **Step 4: 全量测试确认全绿**

Run: `scripts/ios-test.sh 2>&1 | grep -E "Test Suite 'All tests'|Executed|TEST" | tail -3`
Expected: `** TEST SUCCEEDED **`,失败数 0。

- [ ] **Step 5: 提交**

```bash
git add apps/ios/Zhixing/Core/ZXPhotoBrowser.swift apps/ios/Tests/FootprintDetailTests.swift
git commit -m "feat(ios): 看图页接邻页预载,翻页图换图瞬切消灭空窗"
```

---

### Task 3: 探针复验连翻体验 + Mac 重建交走查

**Files:**
- Modify(scratchpad,不入库): `<scratchpad>/probe/Probe/ProbeApp.swift`

**Interfaces:**
- Consumes: Task 2 后的 `ZXPhotoBrowser.swift` 与 Task 1 的 `ZXBrowserPhotoLoader.swift` 源码(复制进探针,`AuthedPhotoView` 替身删除,loader 的 fetch 注入 150-400ms 随机延迟的渐变图字节)。
- Produces: 连翻场景截图证据 + 重建后的 Debug Catalyst App(用户走查)。

- [ ] **Step 1: 探针同步新结构**

把 Task 2 后的 `ZXPhotoBrowser.swift` 正文与 `ZXBrowserPhotoLoader.swift` 正文覆盖进探针(保留 `.probe`/`.probeX` 探针挂点与连点驱动 task);探针里给 loader 注入假 fetch:

```swift
// 探针注入:150-400ms 随机延迟返回渐变 PNG,模拟真实网络+解码节奏
func probeFetch(_ photoId: String) async throws -> Data {
    try? await Task.sleep(for: .milliseconds(Int.random(in: 150...400)))
    let renderer = UIGraphicsImageRenderer(size: CGSize(width: 800, height: 1200))
    return renderer.pngData { ctx in
        let colors = [UIColor.systemTeal.cgColor, UIColor.systemRed.cgColor]
        let gradient = CGGradient(
            colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors as CFArray, locations: nil)!
        ctx.cgContext.drawLinearGradient(
            gradient, start: .zero, end: CGPoint(x: 0, y: 1200), options: [])
        (photoId as NSString).draw(
            at: CGPoint(x: 300, y: 550),
            withAttributes: [.font: UIFont.boldSystemFont(ofSize: 160), .foregroundColor: UIColor.white])
    }
}
```

- [ ] **Step 2: Catalyst 连翻复验**

Run(探针目录): 构建后 `ZX_RAND=1 ZX_CLICKS=20 ./DerivedData/.../Probe` 跑 2 轮,截尾核对每轮 `PROBE settled` 与 `PROBEX` 终值 minX=0;再以 200ms 间隔连翻时用 `screencapture`(模拟器则 `simctl io screenshot`)抓 2-3 帧。
Expected: 相邻翻页帧上是完整照片(预载命中,无灰块);仅跨 3+ 页快跳偶见短暂灰块;绝无整屏黑/半页割裂。

- [ ] **Step 3: 全量测试 + Mac 重建**

Run: `scripts/ios-test.sh 2>&1 | tail -3 && scripts/mac-dev.sh 2>&1 | tail -2`
Expected: `** TEST SUCCEEDED **`;`✅ 已启动 Debug Catalyst App`。

- [ ] **Step 4: 留用户走查并收尾**

告知用户:足迹详情 → 点照片 → 按住"下一张"连点,应感到"图换图"瞬切、无黑屏间隙;首帧打开与跨多页快跳允许一次短暂灰块(设计取舍,spec 决策记录在案)。走查确认后本计划完结。
