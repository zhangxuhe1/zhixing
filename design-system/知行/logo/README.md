# 知行 Logo 资产

生成于 2026-07-20，模型 `gemini-3-pro-image-preview`（生成脚本思路：品牌上下文 + 概念描述，1:1 / 2K 输出）。

## 定稿

- `app-icon-1024.png` — 应用图标定稿（1024×1024，RGB 无透明通道），已同步到
  `apps/ios/Zhixing/Assets.xcassets/AppIcon.appiconset/AppIcon.png`。
- `seal-master-2048.png` — 印章概念原图（2048×2048），图标由它居中裁切缩放而来；
  也可用作宣传物料上的完整 logo。

**概念：朱砂印章。** 宣纸米白底（`#F5F0E3`）铺极淡的松墨绿等高线（呼应"有故事的中国地图"），
中央一方朱文印（朱砂 `#B8402E`），印面「知行」二字阴文。印章 = 人文/典藏感，
等高线 = 地图/行走，直接承载品牌名，60px 下仍清晰可读。

## 辅助图形

- `contour-mountain-2048.png` — 等高线山概念（松墨绿底 + 米白等高线山形 + 朱砂虚线足迹与地点圆点）。
  不适合小尺寸图标（细线会糊），但适合启动页、空状态插画、官网 hero 等大幅面场景。

## 重新生成

提示词要点（英文喂给生图模型）：品牌色四色 + "contemporary Chinese editorial, rice-paper texture,
topographic contour lines, hand-pressed cinnabar seal (朱文印) with 知行 characters, flat vector,
full-bleed square, legible at 60px"。生成后务必人工核对汉字字形是否正确（模型易写坏笔画）。
