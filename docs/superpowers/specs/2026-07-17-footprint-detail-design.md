# 足迹详情页：给私密足迹补上"读"路径

2026-07-17 · 「最近足迹」（`Me/MeScreen.swift`）与「我的足迹地图」地点 sheet（`Me/MyMapScreen.swift` 的 `FootprintPlaceSheet`）点击足迹行都直接弹 `FootprintEditor`。列表行是预览封顶的（正文 2 行、宫格 4 格 +N），而编辑器一张照片都不显示——后果是**一条私密足迹从第 5 张起的照片在全 App 无处可看**，正文超两行也只能进编辑框"以编辑的姿势"读。公开侧的 `StoryDetailView` 只覆盖 PUBLIC+APPROVED 的足迹，帮不上自己的私密内容。本设计新增私有足迹详情页 `FootprintDetailView`，两处入口改为"详情优先"，编辑降级为详情页右上角入口。纯 iOS 改动，服务端与管理端零改动——详情页零新增请求，`Footprint` 模型本就携带完整正文与全部照片 id。

## 决策记录

| 议题 | 决策 | 理由 |
| --- | --- | --- |
| 交互形态 | **详情页优先**：点行进详情，编辑走详情右上角（否决"编辑页里补照片区"与"缩略图直达大图"） | 读是高频动作、编辑是低频动作，现状把低频动作放在了唯一入口上。编辑页补照片区仍被表单气质框住，「编辑足迹」标题 + 保存/取消对"只想看看"的场景别扭；缩略图直达大图救不了正文阅读，且 List 里行点击与格点击手势易冲突。用户看三方案预览后拍板 |
| 呈现方式 | **NavigationLink 推入**（否决 sheet） | iOS「列表 → 详情」标准手势，可侧滑返回；编辑仍以 sheet 盖在详情上，"浏览用推入、编辑用弹层"层次分明。两处入口内部都已有 NavigationStack，技术上直接可推。sheet 方案会叠出双层 modal，长内容沉浸阅读也不如全屏 |
| 数据来源 | **不发新请求**，按 id 从 `FootprintStore` 实时取 | 模型已含全量数据；`store.update` 成功后就地替换数组元素 → 编辑保存后详情自动刷新；足迹从 store 消失（编辑弹层里删除）→ 详情自动退栈 |
| 全屏照片浏览 | **抽通用 `ZXPhotoBrowser`**，照片墙的私有浏览器一并迁移 | 避免 App 里出现两个长得像但各自演化的全屏浏览器；照片墙行为不变（「查看故事」底栏作为可选 bottomBar 注入） |
| 已公开足迹的统计 | 详情页显示只读「获赞 N · 浏览 N」行 | `likeCount`/`viewCount` 模型现成，作者理应看到自己公开内容的反响；私密足迹（无徽标）不显示 |

## 组件与结构改动（全部在 apps/ios）

**新增 `Footprint/FootprintDetailView.swift`**

- 入参 `footprint: Footprint`（进场快照）；渲染时优先取 `store.footprints` 中同 id 的实时值，编辑保存后随 store 就地替换自动刷新。实时值消失（编辑弹层里删了足迹）时自动退栈——注意先等编辑弹层收起再退，参照 `PhotoWallSection` 的 `pendingStoryTarget`/`onDisappear` 串行接手惯例，避免 sheet 与导航 pop 同帧竞争。
- 排版沿用 `StoryDetailView` 的语言：ScrollView + maxWidth 720 居中；地点名 + 日期 + `PublishBadgeLabel`（直接复用）→ 完整正文（serif、lineSpacing 9、`.textSelection(.enabled)`）→ 全部照片整宽竖排（`AuthedPhotoView`，minHeight 220 / maxHeight 280、圆角 18）。照片区用 LazyVStack，几十张图不一次性全发请求。
- `publishBadge == .published` 时正文下方显示「获赞 N · 浏览 N」只读统计行。
- 工具栏右上「编辑」→ sheet 弹出现有 `FootprintEditor`（`.appStores()` 惯例），`FootprintEditor` 零改动。
- 点任意照片 → `fullScreenCover` 打开 `ZXPhotoBrowser`，从该张起左右翻页（`.appStores()` 惯例——Catalyst modal 宿主不继承环境）。

**新增 `Core/ZXPhotoBrowser.swift`（由 `PhotoWallSection` 私有的 `PhotoWallBrowser` 泛化搬迁）**

- 入参：`photoIds: [String]`、`startIndex: Int`、`onClose: () -> Void`、可选 `@ViewBuilder bottomBar: (Int) -> BottomBar`（参数为当前页下标）；bottomBar 为 EmptyView 时不渲染 `safeAreaInset` 底栏。
- 视觉与手势和现状逐一保持：TabView `.page` 翻页、黑底、`ignoresSafeArea`、右上角 xmark 关闭钮（thinMaterial 圆底）、`preferredColorScheme(.dark)`。
- ForEach 身份仍按 photoId 字符串——`WallPhoto.id` 本就是 photoId，属语义等价搬迁（AuthedPhotoView 的 @State 缓存跟随视图身份，同 `ZXPhotoThumbRow` 的护栏理由）。
- `PhotoWallSection` 改用之：`photoIds: session.photos.map(\.photoId)`，底栏注入「查看故事」按钮（由当前下标反查 footprintId），`onViewStory` 既有链路（pendingStoryTarget/onDisappear 串行接手）不动；私有 `PhotoWallBrowser` 删除。

**入口改造：`Me/MeScreen.swift` 与 `Me/MyMapScreen.swift`（`FootprintPlaceSheet`）**

- 行点击由 `Button { editingFootprint = fp }` 改为 `NavigationLink { FootprintDetailView(footprint: fp) }`；两处的 `editingFootprint` 状态与 `.sheet(item:)` 编辑弹层随之删除（编辑入口移入详情页）。
- MeScreen 列表左滑删除（`.onDelete`）保留不动；NavigationLink 在 List 中自带 chevron，是预期的可点提示，不抑制。
- `FootprintPlaceSheet` 在其自有 NavigationStack 内推入（sheet 的 medium/large detents 不变）；行的 accessibilityHint「编辑这段足迹」改为「查看这段足迹」。

XcodeGen 按目录收源码，新文件落位后 `xcodegen generate` 即可入工程。

## 测试

- 新增 `Tests/FootprintDetailTests.swift`，按 `InteractionDesignTests` 源码断言惯例锁定交互契约（具体断言条目实施计划里定），方向：
  - `MeScreen.swift` 与 `MyMapScreen.swift` 点行进 `FootprintDetailView`、不再直弹 `FootprintEditor`；
  - `FootprintDetailView.swift` 含「编辑」工具栏入口、`ZXPhotoBrowser` 引用与已公开统计行；
  - `PhotoWallSection.swift` 引用 `ZXPhotoBrowser`，私有 `PhotoWallBrowser` 不复存在。
- `scripts/ios-test.sh` 全量回归（`PhotoThumbRowTests`、`MyMapRegressionTests` 等既有用例不受影响应全绿）。
- Mac Catalyst 端走查三条路径：列表 → 详情（长正文与 12 张照片全可见）；详情 → 点图全屏翻页；详情 → 编辑 → 保存回流详情 / 删除自动退栈。

## 不做

- 服务端 / 管理端任何改动；不新增任何 API。
- 详情页不做照片增删、重排（编辑器现状也没有，属独立 feature）。
- 不与 `StoryDetailView` 合并——公开故事与私密足迹字段和动作语义不同（作者昵称/点赞按钮 vs 编辑入口/公开徽标），只共享排版语言与 `AuthedPhotoView`。
- `StoryDetailView` 的整宽照片本次不接 `ZXPhotoBrowser`（公开详情内点图放大是另一话题，避免本次范围蔓延）。
- 列表行本身不动（宫格封顶 +N、左滑删除、行高均维持现状）。
