# 网友攻略升级为地点抽屉第四分栏

2026-07-17 · 地点抽屉（PlaceDrawer）目前是三段式分栏：风物卡 / 旅人故事 / 旅人镜头，「网友攻略」外链列表以区块形式拼在风物卡列表底部（[2026-07-15 M3 地点域 spec](2026-07-15-m3-place-domain-design.md) 引入的 `PlaceLink` 在 iOS 的展示形态）。本设计把网友攻略抽出，升级为与三者并列的第四个分栏。纯 iOS 界面调整，服务端与管理端零改动。

对 M3 spec 的一处有意变更：M3 规定「无链接时区块整体不渲染」，那是区块形态下的合理选择；升级为常驻分栏后改为**始终显示 + 空态兜底**（决策见下表）。

## 决策记录

| 议题 | 决策 | 理由 |
| --- | --- | --- |
| 无链接时第四栏是否显示 | **始终显示，空态兜底** | 链接异步加载，条件隐藏会让 tab 打开抽屉后"蹦出来"，且不同地点 tab 数量不一致；旅人故事/旅人镜头无内容时也是常驻+空态，保持一致 |
| 分栏顺序 | **风物卡 / 网友攻略 / 旅人故事 / 旅人镜头** | 延续网友攻略"长在风物卡里"的习惯位置，策展内容（风物卡+攻略）在前、UGC 在后 |
| 数据加载方式 | **自足式 tab**：自己请求 `/places/{id}` 取 `links`，`LoadState` 管理 | 与 StoriesSection / PhotoWallSection 同构，四个 tab 结构对称；失败可见可重试（项目 I2+ 全局约束）。代价是切 tab 多一次同接口小请求，与兄弟 tab 每次切换重拉的现状一致 |

## 交互与界面

- 分段控件（`Picker` + `.segmented`）从三段变四段。四字中文标签在最窄机型（375pt 宽）上每段约 84pt，放得下，不换控件。
- 风物卡列表底部不再拼接链接区块。
- 网友攻略 tab 是独立 `ScrollView` 列表；链接行样式与打开行为完全沿用现状：平台徽章（cinnabar 胶囊）+ 标题 + 右上角箭头，iOS 用 `SFSafariViewController` 应用内打开，Catalyst 交系统默认浏览器，仅放行 https。

## 结构改动（全部在 apps/ios）

**`Place/PlaceDrawer.swift`**
- `DrawerSection` 枚举加 `.links = "网友攻略"`，插在 `.cards` 之后。
- `sectionContent` 加 `case .links: PlaceLinksSection(placeId: pin.id)`。
- `cardsContent` 移除对 `PlaceLinksSection` 与 `placeDetail?.links` 的引用。
- 抽屉自身的静默 `loadDetail()` 保持原样——仍供标题下路径文字与 `drawerLocationText` 兜底，属"锦上添花"，失败静默的语义不变。

**`Place/PlaceLinksSection.swift`**
- 入参从 `links: [PlaceLink]` 改为 `placeId: String`；内部 `@State state: LoadState<[PlaceLink]>`，`.task` 请求 `GET /places/{placeId}`（复用 `PlaceDetail` 解码），取 `links ?? []`。
- 用 `LoadStateView` 渲染三态：加载转圈；失败「网友攻略加载失败，请重试」+ 重试；成功后空列表进空态、非空渲染链接行。
- 链接行视图与 `open(_:)` 逻辑（含 Catalyst 分支、SafariItem sheet）原样保留。

## 空态与异常

- 空态沿用 `ZXSectionEmptyState`：icon `link`，eyebrow「网友攻略」，标题「攻略还在收集中」，正文「我们会陆续为这里挑选值得一看的网友攻略与带玩视频。」
- 网络失败与空数据严格分开：失败走 `LoadStateView` 的重试路径，不得伪装成空态。

## 测试

- 按 `InteractionDesignTests` 源码断言惯例补一条用例：`DrawerSection` 含四段且网友攻略紧随风物卡之后；`cardsContent` 不再引用 `PlaceLinksSection`；`PlaceLinksSection` 使用 `LoadStateView`。
- `scripts/ios-test.sh` 全量回归（`ModelsTests` 不受影响，`PlaceDetail.links` 字段未动）。

## 不做

- 服务端 / 管理端任何改动（`/places/{id}` 已返回 `links`）。
- tab 上的数量徽标、链接排序调整、用户提交外链入口。
- 抽屉 `loadDetail` 改造成 `LoadState`（路径文字仍是锦上添花，不绑关键路径）。
