# M1 内容灌入 Runbook（TestFlight 前执行）

前提：`pnpm db:up`；`.env` 配好 GEMINI_API_KEY（联网检索）；`docker compose` 的 db 在跑。

1. 导入地点库：
   pnpm --filter @zhixing/pipeline import-places     # 北京 16 点（幂等）
   pnpm --filter @zhixing/pipeline import-regions    # 6 熟悉地区 + 10 省会（幂等）
2. 全国铺底（每地 ≥3 张，分类轮转；~80 张，配额紧张可分天跑）：
   pnpm --filter @zhixing/pipeline batch -- --fill 3 --delay 4000
3. 北京加深（样板间，每点 ≥5 张）：
   pnpm --filter @zhixing/pipeline batch -- --fill 5 --city 北京市 --delay 4000
4. 抽查复核：后台 http://localhost:3000/cards 通读新卡——开头非百科腔、有细节锚点、
   传说带"相传"、来源非空；不合格的直接「下架」，跑 batch 会自动补足缺口。
5. TestFlight 门槛（不达标就继续跑 batch）：
   - 总卡数 ≥ 80；北京每点 ≥5；六地每点 ≥3；省会每城 ≥3
   - 「AI 整理·待复核」标识由 iOS 端展示，M1 不要求全部人工复核（规格书 §3.2）

成本记录：每张卡 1 次检索 + 1 次成稿调用；失败会跳过，重跑 batch 幂等补齐。
