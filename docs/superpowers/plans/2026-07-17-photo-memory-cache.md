# 全局照片内存缓存 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** photoId → 降采样位图的会话级 NSCache,宫格与看图页一处下载全 App 复用,根治首开黑闪与宫格全分辨率解码内存隐患。

**Architecture:** 新增 `ZXPhotoMemoryCache`(NSCache,cost=像素字节,总量封顶,内存压力自动清退);`AuthedPhotoView` 渲染前同步查缓存、未命中降采样解码后写回;`ZXBrowserPhotoLoader.load()` 先查缓存零网络命中,解码成功反哺缓存。

**Tech Stack:** NSCache、ImageIO 降采样(既有 `downsampledImage`)、XCTest。

**Spec:** docs/superpowers/specs/2026-07-17-photo-memory-cache-design.md

## Global Constraints

- Swift 6 strict + iOS 17,双目标;注释/提交中文,conventional commits。
- 不落盘(规格书 §5.1);cost 上限 Catalyst 200MB / iOS 120MB。
- 位图尺寸权威:`ZXPhotoMemoryCache.displayMaxPixelSize()`(主屏长边×scale 夹 [2048,4096]),loader 与 AuthedPhotoView 共用。
- 看图页三护栏与 loader 既有测试不得回退。

---

### Task 1: `ZXPhotoMemoryCache` + `AuthedPhotoView` 改造(先测后码)

**Files:**
- Create: `apps/ios/Zhixing/Core/ZXPhotoMemoryCache.swift`
- Modify: `apps/ios/Zhixing/Footprint/AuthedPhotoView.swift`
- Test: `apps/ios/Tests/PhotoMemoryCacheTests.swift`(新建)

**Interfaces:**
- Produces:`final class ZXPhotoMemoryCache` — `static let shared`;`func image(for photoId: String) -> UIImage?`;`func insert(_ image: UIImage, for photoId: String)`;`func removeAll()`;`@MainActor static func displayMaxPixelSize() -> CGFloat`。

- [ ] Step 1: 写失败测试 `PhotoMemoryCacheTests`:存取往返、removeAll 清空、契约断言(AuthedPhotoView 含 `ZXPhotoMemoryCache`/`downsampledImage`、不含 `UIImage(data: data)`;loader 含 `ZXPhotoMemoryCache`)。
- [ ] Step 2: 跑测试确认失败(类型不存在)。
- [ ] Step 3: 实现 cache;AuthedPhotoView:body 先查缓存命中直出,load() 解码改 `downsampledImage` + 写缓存。
- [ ] Step 4: `scripts/ios-test.sh` 全绿(loader 契约留 Task 2,故契约断言按任务拆分:本任务只断言 AuthedPhotoView)。
- [ ] Step 5: commit `feat(ios): 全局照片内存缓存,宫格降采样解码接入`

### Task 2: loader 接缓存 + 回归收尾

**Files:**
- Modify: `apps/ios/Zhixing/Core/ZXBrowserPhotoLoader.swift`
- Modify: `apps/ios/Tests/BrowserPhotoLoaderTests.swift`(setUp 清缓存 + 命中用例)
- Modify: `apps/ios/Tests/PhotoMemoryCacheTests.swift`(补 loader 契约断言)

**Interfaces:**
- Consumes: Task 1 全部接口。

- [ ] Step 1: 先加失败测试:种缓存 → focus → images 就位且 fetch 零调用;loader 源码契约断言。
- [ ] Step 2: 确认新用例红。
- [ ] Step 3: `load()` 首查缓存命中短路;解码成功 `insert` 反哺;`displayMaxPixelSize` 上收(loader 私有 `screenMaxPixelSize` 删除)。
- [ ] Step 4: `scripts/ios-test.sh` 全绿;`scripts/mac-dev.sh` 重建。
- [ ] Step 5: commit `feat(ios): 看图页 loader 接全局缓存,宫格点开首帧即图`;交用户走查(宫格点开应无黑闪)。
