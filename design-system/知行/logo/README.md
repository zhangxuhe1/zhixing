# 知行 Logo 资产

生成于 2026-07-20，模型 `gemini-3-pro-image-preview`（品牌上下文 + 概念描述提示词，1:1 / 2K）。
两轮设计：第一轮为带字印章方案（已废弃），第二轮按"无字图形符号"重做——参考知名品牌
无字标逻辑：符号必须自带可讲述的概念，且 60px 下 100ms 内可识别。

## 定稿：山径一笔（c3）

- `app-icon-1024.png` — 应用图标定稿（1024×1024，RGB 无透明通道），已同步到
  `apps/ios/Zhixing/Assets.xcassets/AppIcon.appiconset/AppIcon.png`。
- `mark-mountain-path-2048.png` — 图形原稿（2048×2048，宣纸米白底）。

**概念：** 一笔松墨勾出主峰与侧峰，笔势不断、顺势折为蜿蜒归途，收在一枚朱砂圆点上。
山 = 知（山河/文化/典藏），路 = 行（行走/足迹），朱砂点 = 你抵达的地方。
"知行合一，一笔写完。" 墨笔书法气质 + 当代极简几何，60px 小尺寸验证通过。

## 备选方向（未采用，保留原稿）

- `alt-contour-fingerprint-2048.png` — 指纹等高线：山形等高线内圈旋成指纹涡心，虚线小径
  切入朱砂圆心。概念独占性最强（足迹=指纹=山河），但小尺寸圈线略糊。
- `alt-seal-path-2048.png` — 无字之印：朱砂印面刻一条蜿蜒的路（"把走过的路铭成一方印"）。
  小尺寸最醒目，但曲线易误读为蛇形。
- `seal-master-2048.png` / `contour-mountain-2048.png` — 第一轮存档（带字印章 / 等高线山，
  后者仍适合启动页、空状态、官网大图等大幅面场景）。

## 重新生成

提示词要点（英文喂给生图模型）：四色品牌色 + "WORDLESS abstract brand mark, ONE continuous
ink-brush stroke: mountain silhouette flowing into a winding path, ending at a cinnabar dot,
flat vector with calligraphic line-weight variation, rice-paper cream field, centered, legible
at 60px, STRICTLY NO text/letters/characters"。生成后必须做 60px 缩小测试再定稿。
