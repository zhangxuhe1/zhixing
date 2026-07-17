# 全屏看图页:邻页预载消灭翻页空窗

2026-07-17 · `ZXPhotoBrowser` 连点竞态修复后按钮翻页为无动画瞬切,但每页照片(`AuthedPhotoView`)都是翻到时才"换签名 URL→下载→解码",黑底上灰块占位形成肉眼可见的空窗,快速连翻时页页踩空尤其僵硬。对标 Mac 主流看图应用(Preview/Photos/QuickLook):它们同样是瞬切,丝滑的真正来源是**相邻图片提前解码好了**,翻页永远"图换图"。本设计给看图页加会话级邻页预载:停在第 i 张时后台补齐 i±1、i±2 的降采样解码图,内存最多留 5 张,关闭全释放。顺带根治看图页现存的全分辨率解码内存隐患(24MP 原图 `UIImage(data:)` 全尺寸位图近百 MB/张)。纯 iOS 改动,只动看图页,宫格与其他使用面零改动。

## 决策记录

| 议题 | 决策 | 理由 |
| --- | --- | --- |
| 翻页过渡口味 | **纯瞬切**(否决"瞬切+~120ms 轻淡入") | Preview/Photos/QuickLook 皆瞬切,与 Mac 端"对标原生"方向一致;淡入在快速连翻下会被频繁打断。用户拍板 |
| 冷启首帧 | **接受打开时一次短暂占位**(否决顺带做全局照片内存缓存) | 用户报的痛点是连翻空窗,预载即根治;全局缓存收益更大但改动面波及 `AuthedPhotoView` 全部使用面,留作后续独立话题。用户拍板 |
| 实现载体 | **看图页自持加载器 `ZXBrowserPhotoLoader`**(否决"隐形预载视图暖 `AuthedPhotoView` @State"hack 与全局 NSCache) | 单一职责、边界清晰、逻辑可无网络单测;hack 方案内存无上限、无去重与优先级、依赖视图生命周期,全局缓存超出本次范围 |
| 解码尺寸 | 复用 `TripShareScreen` 的评审版 `downsampledImage`,长边 = 主屏长边×scale,夹在 [2048, 4096] | ImageIO 按目标尺寸直接解码,全程不产生原始分辨率位图;上限防 5K 全屏场景内存失控,下限保证常规窗口清晰度 |
| 缓存策略 | 预载窗口 [i, i+1, i-1, i+2, i-2],缓存上限 5 张,窗口外淘汰、在途任务取消;仅内存、不落盘,看图页关闭随 @State 整体释放 | 连翻场景邻页命中即够;私密照片不落磁盘缓存的约束(规格书 §5.1、`photoSession` ephemeral)原样保持 |

## 组件与结构改动(全部在 apps/ios)

**新增 `Core/ZXBrowserPhotoLoader.swift`**

- `@MainActor @Observable final class ZXBrowserPhotoLoader`:
  - 状态:`private(set) var images: [String: UIImage]`(已解码缓存)、`private(set) var failed: Set<String>`(失败集,驱动页内重试态)、`private var inflight: [String: Task<Void, Never>]`(去重)。
  - `init(photoIds: [String], fetch: @escaping (String) async throws -> Data = 默认实现, maxPixelSize: CGFloat = 屏幕推导)`——默认 fetch 走既有链路:presign `GET /photos/:id` → `APIClient.photoSession` 下载;注入点供单测喂假数据。
  - `func focus(_ index: Int)`:按窗口纯函数补齐缺失项(已缓存/在途/已失败跳过),下载与降采样解码在后台任务执行、回主线程写缓存;窗口外的缓存淘汰、在途任务取消。
  - `func retry(_ photoId: String)`:从 `failed` 移除并重新拉取(仍限窗口内的页触发)。
  - `nonisolated static func prefetchWindow(around index: Int, count: Int) -> [Int]`:优先级序 [i, i+1, i-1, i+2, i-2] 截断越界,纯函数可单测(仿 `ZXPhotoGrid.layout` 惯例)。
- 失败语义与 `AuthedPhotoView` 一致:单张失败不影响其他页,页内点重试。

**`Core/ZXPhotoBrowser.swift` 改动**

- `@State private var loader: ZXBrowserPhotoLoader`,init 里以 `photoIds` 构造;`body` 挂 `.task { loader.focus(selection) }` 与 `.onChange(of: selection) { loader.focus(selection) }`。
- 页视图从 `AuthedPhotoView` 换为私有 `pagePhoto(photoId:)`:有图 → `Image(uiImage:).resizable().scaledToFill()`;在途 → 灰块 + 小菊花(样式同 `AuthedPhotoView` loading 分支);失败 → 灰块 + 重试按钮(样式同其 failed 分支,action 调 `loader.retry`)。
- 两条既有护栏原样保留:页尺寸权威 `Color.clear` + overlay + `.clipped()`;按钮翻页无动画瞬切。图就位时的替换同样无动画,与瞬切口味一致。
- 看图页不再使用 `AuthedPhotoView`;宫格、缩略行、故事详情等其他使用面不动。

**测试(apps/ios/Tests)**

- 新增 `BrowserPhotoLoaderTests`:`prefetchWindow` 窗口与越界截断;注入假 fetch 验证——focus 只拉窗口内缺失项、在途去重、窗口滑动后淘汰与取消、失败进 `failed`、retry 重新拉取成功。
- `FootprintDetailTests` 契约更新:页结构断言从 `.overlay { AuthedPhotoView(...) }` 改为新页视图;新增"看图页必须走 `ZXBrowserPhotoLoader` 预载"断言;无动画翻页与 `Color.clear` 尺寸权威断言保留。

**验证**:探针 app 复跑快速连翻场景(loader 结构同步进探针)+ 模拟器截图确认翻页无整屏空窗;`scripts/ios-test.sh` 全绿;`mac-dev.sh` 重建后用户走查。
