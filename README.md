# 知行 zhixing

一张有故事的中国地图。产品设计见 docs/superpowers/specs/2026-07-06-zhixing-design.md。

## 开发

```sh
pnpm install
pnpm db:up                      # 启动 Postgres（宿主机端口 5433，zhixing + zhixing_test 两个库）
pnpm --filter @zhixing/db exec prisma migrate dev   # 建表
pnpm --filter @zhixing/api dev  # API :8787
pnpm --filter @zhixing/admin dev # 管理后台 :3000
pnpm test                       # 全部测试
```

## 内容管线（AI 风物卡）

LLM 供应商支持 Gemini 与 DeepSeek：`cp .env.example .env`，取消注释并填写 `GEMINI_API_KEY` 或 `DEEPSEEK_API_KEY`（一条即可），其余变量保持注释走默认值。API 与管线启动时会自动加载根目录 `.env`。研究步骤的联网检索仅 Gemini 支持；DeepSeek 下自动跳过检索、直接成稿。

```sh
pnpm --filter @zhixing/pipeline import-places   # 导入北京地点库
pnpm --filter @zhixing/pipeline generate -- --place 什刹海 --category ANECDOTE --count 1
```
