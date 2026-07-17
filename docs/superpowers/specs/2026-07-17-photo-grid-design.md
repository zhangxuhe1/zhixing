# 详情页照片区:整宽横幅改自适应宫格

2026-07-17 · `FootprintDetailView` 与 `StoryDetailView` 的照片区把每张照片塞进"整宽横幅"框(`maxWidth: .infinity, minHeight: 220, maxHeight: 280` + `AuthedPhotoView` 的 `scaledToFill`),框外直接裁掉。Mac Catalyst 宽窗口下该框约 720×280(≈2.6:1 宽扁横条),方图/竖图只剩中间一条横带,内容基本不可辨;且每张独占约 300pt 纵向空间,12 张照片 ≈ 3600pt 长滚动。本设计新增共用组件 `ZXPhotoGrid`,按张数三档自适应(1 张题图 / 2 张对分 / ≥3 张三列宫格),两个详情页一并换装;公开故事详情页因缩略化连带接上 `ZXPhotoBrowser` 全屏浏览。纯 iOS 改动,服务端与管理端零改动。

## 决策记录

| 议题 | 决策 | 理由 |
| --- | --- | --- |
| 布局形态 | **按张数自适应宫格**(否决"统一三列宫格"与"单列 scaledToFit") | 统一宫格在单张足迹(高频场景)下一小格独占、观感单薄;单列 scaledToFit 解决裁切但 12 张仍是十几屏长滚动,两项主诉求只中其一。自适应三档兼顾:单张保留题图气质,多张紧凑一屏看全。用户看两方案预览后拍板 |
| 档位划分 | 1 张=整宽 4:3 / 2 张=两格 1:1 对分 / ≥3 张=三列 1:1 宫格;4 张不做微信式 2×2 特例 | 三档已覆盖观感问题,2×2 特例是可有可无的雕花(YAGNI) |
| 单张为何定死 4:3 | **固定宽高比,不按原图比例自适应** | 照片模型(`FootprintPhotoMeta`/`StoryPhoto`)只有 id 没有宽高,图是异步加载的——按原图自适应会在加载完成后跳版式。4:3 下竖图仍有裁切,但远好于现状 2.6:1,且点开全屏即完整图 |
| 修复范围 | **两个详情页一起修**,抽共用组件 `Core/ZXPhotoGrid.swift` | `StoryDetailView.swift:50-54` 与足迹详情是一模一样的横幅裁切代码,同样的病一次根治,两页观感一致。用户拍板 |
| 公开页点图放大 | **本次接上**(推翻 2026-07-17 足迹详情设计里"另一话题"的搁置) | 当时搁置的前提是整宽大图勉强可读;改成缩略宫格后没有全屏路径就等于看不了大图,缩略化与全屏浏览必须成对出现。用现成的 `ZXPhotoBrowser` 无底栏便捷构造,增量极小 |

## 组件与结构改动(全部在 apps/ios)

**新增 `Core/ZXPhotoGrid.swift`**

- 入参:`photoIds: [String]`、`onTap: (Int) -> Void`(参数为被点格子的下标,供调用方定位全屏起点)。`photoIds` 为空时渲染空视图。
- 三档布局:
  - **1 张**:整宽、`aspectRatio(4/3, contentMode: .fit)` 定框 + 图作 overlay 填充,圆角 18(延续现有题图语言);
  - **2 张**:HStack 两格 1:1,间距 4,圆角 8;
  - **≥3 张**:`LazyVGrid` 三列 `.flexible`,间距 4,格子 1:1,圆角 8(与 `ZXPhotoThumbRow` 缩略语言一致)。
- 方格裁切必须用照片墙踩坑后的写法(`PhotoWallSection.swift:97` 注释):`Color.clear` 按格宽上报方形提案 + `AuthedPhotoView` 作 overlay + `.clipped()`——`AuthedPhotoView` 的 loaded 分支是 `scaledToFill`,直接对其 `.aspectRatio(1, .fit)` 裁不住。
- 格子身份绑照片 id 而非位置(`ForEach(..., id: \.element)`,同 `ZXPhotoThumbRow` 护栏:`AuthedPhotoView` 的 `@State` 图片缓存跟随视图身份,按位置认身份会在删除/重排后串图)。
- 档位选择抽成可单测纯函数(仿 `ZXPhotoThumbRow.overflow` 的 `nonisolated static` 惯例):`nonisolated static func layout(for count: Int) -> Layout`,`Layout` 为 `single / pair / grid` 三值枚举(0 张由 body 的空视图分支短路,纯函数只需对 ≥1 有定义)。
- 无障碍:每格 `accessibilityLabel("第 x 张照片,共 N 张,点按全屏查看")`,收编现在散在 `FootprintDetailView` 里的同款文案;组件源码不得出现具体业务文案(同 `ZXPhotoBrowser` 约定)。
- 取舍说明:宫格缩略后单屏可见格子变多,首屏图片请求并发上升——与照片墙同形态,可接受;`LazyVGrid` 仍是惰性容器,几十张也不会一次全建视图。

**`Footprint/FootprintDetailView.swift` 换装**

- 照片区 `ForEach` 整宽横幅(59-67 行)整体替换为 `ZXPhotoGrid(photoIds: current.photos.map(\.id)) { browseStart = BrowseStart(index: $0) }`。
- `BrowseStart`、`fullScreenCover` + `ZXPhotoBrowser`、编辑/删除退栈等其余逻辑零改动。

**`Place/StoryDetailView.swift` 换装 + 接全屏浏览**

- 照片区 `ForEach` 整宽横幅(50-54 行)替换为 `ZXPhotoGrid`。
- 新增浏览起点状态(仿 `FootprintDetailView.BrowseStart` 的 Identifiable 装箱)+ `fullScreenCover` 打开 `ZXPhotoBrowser`(无底栏便捷构造,`photoIds: story.photos.map(\.photoId)`),`.appStores()` 惯例——Catalyst modal 宿主不继承环境。

XcodeGen 按目录收源码,新文件落位后 `xcodegen generate` 即可入工程。

## 测试

- 新增 `Tests/PhotoGridTests.swift`:
  - `ZXPhotoGrid.layout(for:)` 纯函数单测:1→single、2→pair、3/4/12→grid;
  - 源码断言(既有 `InteractionDesignTests` 惯例):`FootprintDetailView.swift` 与 `StoryDetailView.swift` 均引用 `ZXPhotoGrid`、不再含 `minHeight: 220` 整宽横幅;`StoryDetailView.swift` 引用 `ZXPhotoBrowser`;`ZXPhotoGrid.swift` 含 `Color.clear` 方格裁切写法。
- 既有 `FootprintDetailTests`、`PhotoThumbRowTests` 等全量回归(`scripts/ios-test.sh`;模拟器偶发 Busy 瞬态失败重跑即过)。
- Mac Catalyst 端走查:香港 12 张测试足迹详情(宫格 4 行约一屏、点任意格全屏翻页起点正确);单张 / 双张足迹各一条(题图 / 对分档位);公开故事详情宫格 + 点图全屏。

## 不做

- 服务端 / 管理端任何改动;不新增任何 API。
- `PhotoWallSection`(带月份分组的照片墙)与 `ZXPhotoThumbRow`(列表缩略行)不动——形态语义不同,只共享底层写法。
- `ZXPhotoBrowser` 零改动(无底栏构造现成)。
- 不做 4 张 2×2 特例;不按原图宽高比自适应布局(理由见决策记录)。
- 不做宫格内照片增删、重排、长按菜单(详情页仍是纯"读"路径)。
