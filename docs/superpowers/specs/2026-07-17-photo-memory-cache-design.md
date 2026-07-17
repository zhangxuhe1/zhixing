# 全局照片内存缓存:看图页开门即现,照片链路一处下载

2026-07-17 · 看图页邻页预载(同日 photo-browser-preload 设计)落地后,首开黑屏一闪仍稳定复现:录像逐帧实证为"纯黑封面滑入 → 近黑占位(灰块在黑底+深色模式下≈黑)→ 出图"。根因是冷启首帧无图可放——宫格里那张图刚下载解码过,但各视图的图是私有 @State,看图页拿不到。本设计推翻 preload 设计里"冷启首帧接受短暂占位"的决策(用户走查确认痛点后拍板),上**会话级全局内存照片缓存**:photoId → 降采样位图,一处下载、全 App 复用。宫格看过的照片点开全屏第一帧即图,黑闪根治;重复下载消失;宫格现存的全分辨率解码内存隐患(24MP≈90MB/张、无上界)一并根治为有界缓存。纯 iOS 改动。

## 决策记录

| 议题 | 决策 | 理由 |
| --- | --- | --- |
| 修法 | **全局内存缓存**(否决"只做观感缓解") | 观感方案治不了"图不在";缓存是开门即现 + 重复下载消失 + 内存从无界变有界三赢。用户问清体验/资源影响后拍板 |
| 缓存键与失效 | `photoId` → 位图,**无失效钩子** | API 仅 `POST /footprints/:id/photos`(新建)与 `GET /photos/:id`(presign),无按 id 改写字节的端点——id 不可变,按 id 缓存天然安全(已核实 routes/photos.ts) |
| 存储载体 | `NSCache`,cost=像素字节,totalCostLimit:Catalyst 200MB / iOS 120MB | 线程安全、内存压力自动清退是原生行为;不落盘,私密照片约束(规格书 §5.1)原样保持,退出 App 即消失 |
| 位图尺寸 | 与看图页一致:主屏长边×scale 夹 [2048, 4096],**一份位图服务所有面** | 宫格用它超规格但换来复用与简单;宫格解码由此从 `UIImage(data:)` 全分辨率改为 ImageIO 降采样,内存隐患根治 |
| 命中语义 | 宫格点开的图必然刚被格子渲染过 → 看图页首帧 100% 命中 | 黑闪在"从宫格/照片墙点开"路径上彻底消失;真正首次见的图(如深链)仍占位,是网络物理下限 |
| 呈现方式(追记) | 看图页开与关一律**无动画瞬切**:调用面状态变更经 `zxInstantPresent`(禁动画事务)包裹;另 loader init 需带 startIndex 构造期同步种缓存(focus 挂 .task,首帧之后才跑) | 缓存就位后黑闪仍在:探针录像实证 fullScreenCover 滑入/滑出过渡会在照片上方暴露封面黑底横带,内容首帧就绪也消不掉;无动画对照组两帧直切零残影。Preview/Photos 原生即"点开即在"。用户走查拍板 |

## 组件与结构改动(全部在 apps/ios)

**新增 `Core/ZXPhotoMemoryCache.swift`**

- `final class ZXPhotoMemoryCache`(nonisolated,NSCache 本身线程安全):`static let shared`;`func image(for photoId: String) -> UIImage?`;`func insert(_ image: UIImage, for photoId: String)`(cost = 像素字节);`func removeAll()`(测试隔离用)。
- `@MainActor static func displayMaxPixelSize() -> CGFloat`:主屏长边×scale 夹 [2048, 4096]——从 `ZXBrowserPhotoLoader` 的私有实现上收为公共权威,loader 与 `AuthedPhotoView` 共用。

**`Footprint/AuthedPhotoView.swift` 改造**

- body 渲染前先同步查缓存,命中直接出图(不闪一帧占位);未命中走原 presign 链路,但解码从 `UIImage(data:)` 改为 `downsampledImage(from:maxPixelSize: displayMaxPixelSize())`,成功后写入缓存再进 `.loaded`。
- 加载/失败/重试三态语义与样式不变。

**`Core/ZXBrowserPhotoLoader.swift` 接缓存**

- `load()` 先查 `ZXPhotoMemoryCache.shared`,命中 → 直接进 `images`,零网络;解码成功后写回缓存(看图页预载的邻页反哺宫格与下次会话内打开)。
- 自身窗口淘汰语义不变(窗口 dict 只是缓存之上的强引用窗口)。

**测试(apps/ios/Tests)**

- 新增 `PhotoMemoryCacheTests`:cache 存取与 removeAll;源码契约——`AuthedPhotoView` 必须引用 `ZXPhotoMemoryCache` 与 `downsampledImage`、不得再出现 `UIImage(data: data)`;`ZXBrowserPhotoLoader` 必须查/写缓存。
- `BrowserPhotoLoaderTests`:`setUp` 清 shared 缓存(测试隔离);新增缓存命中用例(种缓存 → focus → 就位且 fetch 零调用)。

**验证**:`scripts/ios-test.sh` 全绿;`mac-dev.sh` 重建后用户走查——宫格点开任意看过的照片应第一帧即图、无黑闪。
