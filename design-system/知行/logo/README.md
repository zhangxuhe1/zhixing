# 知行 Logo 资产

定稿于 2026-07-20，模型 `gemini-3-pro-image-preview` 生成（两轮比选，第二轮无字图形标胜出）。

## 定稿：山径一笔

- `app-icon-1024.png` — 应用图标（1024×1024，RGB 无透明通道），已同步到
  `apps/ios/Zhixing/Assets.xcassets/AppIcon.appiconset/AppIcon.png`。
- `mark-mountain-path-2048.png` — 图形原稿（2048×2048，宣纸米白底 `#F5F0E3`）。

**概念：** 一笔松墨（`#153F36`）勾出主峰与侧峰，笔势不断、顺势折为蜿蜒归途，收在一枚
朱砂圆点（`#B8402E`）上。山 = 知（山河/文化），路 = 行（行走/足迹），朱砂点 = 你抵达的
地方。"知行合一，一笔写完。" 60px 缩小测试通过。

应用内复用该标时，从原稿抠出透明底图形（宣纸底为纯色，可色键抠图），或直接用图标圆角
方块形式呈现（登录徽标、关于行等"应用身份"场景）。

## 已落地位置清单（换标时逐处同步）

- `apps/ios/Zhixing/Assets.xcassets/AppIcon.appiconset/AppIcon.png` — 应用图标（1024，无透明通道）
- `apps/ios/Zhixing/Assets.xcassets/BrandMark.imageset/` — 透明底图形标母版（256px），用于
  登录页徽标 / Catalyst 侧栏头 / 会话恢复启动画面（均垫 rice 底砖）
- `apps/api/assets/email-logo.png` — 验证码邮件品牌头小样（160px 米色圆角方块，CID 内联附件）
- `apps/admin/app/icon.png` — 管理后台 favicon（256px，Next App Router 约定）

## 重新生成

提示词要点（英文喂给生图模型）：品牌色 + "WORDLESS abstract brand mark, ONE continuous
ink-brush stroke: mountain silhouette flowing into a winding path, ending at a cinnabar dot,
flat vector with calligraphic line-weight variation, rice-paper cream field, centered, legible
at 60px, STRICTLY NO text/letters/characters"。生成后必须做 60px 缩小测试再定稿。
