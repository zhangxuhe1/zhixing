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

LLM 供应商支持 Gemini 与 DeepSeek，配置 `GEMINI_API_KEY` 或 `DEEPSEEK_API_KEY`（见 `.env.example`）。研究步骤的联网检索仅 Gemini 支持；DeepSeek 下自动跳过检索、直接成稿。

```sh
export DATABASE_URL=postgresql://zhixing:zhixing@localhost:5433/zhixing
pnpm --filter @zhixing/pipeline import-places   # 导入北京地点库
pnpm --filter @zhixing/pipeline generate -- --place 什刹海 --category ANECDOTE --count 1
```
