# 足迹与故事列表多图缩略样式：宫格封顶 +N

2026-07-17 · 「最近足迹」（`Me/MeScreen.swift` 的 `FootprintRow`）与地点抽屉「旅人故事」列表（`Place/StoriesSection.swift`）目前用同一款 72×72 横滑照片条：有几张排几张，超出屏幕靠左滑。问题：不告诉用户总共有多少张（滑动暗示全凭最后一张是否恰好被切一半）、横滑与 List 纵向滚动 / 左滑删除抢手势、且 `HStack` 非 lazy——20 张图的足迹在列表里出现即发起 20 个请求。本设计把两处统一换成"宫格封顶 +N"：最多显示 4 格，溢出时第 4 格盖遮罩显示剩余张数。纯 iOS 界面调整，服务端与管理端零改动。

四种候选样式（现状横滑 / 宫格 +N / 叠卡 / 拼贴）的交互式对比预览：<https://claude.ai/code/artifact/487ad94e-5169-4a34-a9c8-4dd56e1d4007>。

## 决策记录

| 议题 | 决策 | 理由 |
| --- | --- | --- |
| 样式选型 | **宫格封顶 +N**（否决叠卡、拼贴、维持横滑） | 列表场景主流做法（微博 / X / Facebook / Airbnb 点评）：总数精确可知、行高恒定、无手势冲突、加载有上界。叠卡一眼只剩 1 张信息量，主流产品只当入口隐喻；拼贴行高翻倍，会把"清单"变成"信息流"。用户看预览后拍板 |
| 应用范围 | **最近足迹 + 旅人故事两处一起换**，抽共用组件 | 两处本就是同款横滑条，一起换保持全局一致；`StoryDetailView` 的整宽大图是详情场景，不动 |
| +N 计数口径 | **N = 总数 − 4**，第 4 格本身是第 4 张照片盖遮罩 | 微博 / X 惯例：遮罩数字 = 没露脸的张数。5 张 → +1，12 张 → +8 |
| 溢出格是否单独可点 | **不可点**，整行点击行为不变 | 足迹行整行开编辑器、故事行点按弹 `StoryDetailView`（详情内整宽展示全部照片），"看全部"已有去处；不再加二级手势 |

## 组件与结构改动（全部在 apps/ios）

**新增 `Core/ZXPhotoThumbRow.swift`**

- 入参 `photoIds: [String]`；常量 `maxVisible = 4`。
- 渲染：`HStack(spacing: 6)`（无 ScrollView），前 `min(4, count)` 张各为 `AuthedPhotoView` 72×72、`RoundedRectangle(cornerRadius: 8)` 裁切——规格与现状完全一致，只是去掉横滑。
- 溢出时第 4 格叠 `Color.black.opacity(0.45)` 遮罩 + 白色 `+N`（17pt semibold）。遮罩数字由可单测的纯函数给出：`static func overflow(total: Int) -> Int?`（total > 4 时返回 total − 4，否则 nil）。
- 无障碍：`.accessibilityElement(children: .ignore)` + label「照片，共 N 张」，替代逐张朗读。
- 附带收益：每行图片请求数上界从"全部照片"降到 4。

**`Me/MeScreen.swift`（FootprintRow）与 `Place/StoriesSection.swift`**

- 各自的 `ScrollView(.horizontal) { HStack { ForEach … AuthedPhotoView } }` 照片条整块替换为 `ZXPhotoThumbRow(photoIds: photos.map(\.id))`。
- 行的其余部分（标题、日期、正文、点赞区、点击行为）不动。

XcodeGen 按目录收源码，新文件落 `Core/` 后 `xcodegen generate` 即可入工程。

## 测试

- 新增 `Tests/PhotoThumbRowTests.swift`：
  - `overflow` 纯函数用例：1 → nil，4 → nil，5 → 1，12 → 8。
  - 按 `InteractionDesignTests` 源码断言惯例：`MeScreen.swift` 与 `StoriesSection.swift` 不再含横滑照片条（`ScrollView(.horizontal`），且均引用 `ZXPhotoThumbRow`；组件源码含 72×72 规格与无障碍 label，防止视觉重构悄悄破坏。
- `scripts/ios-test.sh` 全量回归。

## 不做

- 网友攻略（`PlaceLinksSection`，外链列表）不涉及——它本就没有照片。
- 服务端 / 管理端任何改动。
- 照片点开大图浏览、九宫格展开、拖拽排序。
- `StoryDetailView`（详情整宽大图）与 `PhotoWallSection`（旅人镜头方格墙，另一场景）不动。
- 叠卡 / 拼贴样式不保留代码路径；若日后 Me 页转"手记"气质再议拼贴。
