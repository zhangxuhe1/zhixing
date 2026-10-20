# 知行 zhixing

一张有故事的中国地图。产品设计见 docs/superpowers/specs/2026-07-06-zhixing-design.md。

## 开发

```sh
pnpm install
pnpm db:up                      # Postgres(:5433) + MinIO(:9000)
pnpm --filter @zhixing/db exec prisma migrate dev   # 建表（fresh clone 后会顺带 prisma generate）
pnpm --filter @zhixing/pipeline import-places       # 北京地点
pnpm --filter @zhixing/pipeline import-regions      # 六地 + 省会
pnpm --filter @zhixing/api dev  # API :8787（iOS 模拟器直连 localhost）
pnpm --filter @zhixing/admin dev # 管理后台 :3000
pnpm test                       # 全部测试
```

- 内容灌入见 docs/content-ops.md；部署见 docs/deploy.md
- iOS 工程见 apps/ios（需 Xcode，计划：docs/superpowers/plans/2026-07-07-m1-ios.md）
- 发布地址、发件人和私人运维资料的本地配置见 [私人配置说明](docs/private-config.md)；
  Mac/iOS Release 构建前需填写被 Git 忽略的 `apps/ios/Config/Release.local.xcconfig`。

## 内容管线（AI 风物卡）

LLM 供应商支持 Gemini 与 DeepSeek：`cp .env.example .env`，取消注释并填写 `GEMINI_API_KEY` 或 `DEEPSEEK_API_KEY`（一条即可），其余变量保持注释走默认值。API 与管线启动时会自动加载根目录 `.env`。研究步骤的联网检索仅 Gemini 支持；DeepSeek 下自动跳过检索、直接成稿。

```sh
pnpm --filter @zhixing/pipeline import-places   # 导入北京地点库
pnpm --filter @zhixing/pipeline generate -- --place 什刹海 --category ANECDOTE --count 1
```
