# 内容运营手册（地点库与风物卡）

前提：`pnpm db:up`；`.env` 配好 GEMINI_API_KEY（联网检索）；`docker compose` 的 db 在跑。
后台地址以本地 http://localhost:3000 为例（生产环境替换为线上 admin 地址）。

## 一、首次灌入（M1 Runbook，TestFlight 前执行，已完成）

1. 导入地点库：
   pnpm --filter @zhixing/pipeline import-places     # 北京 16 点（幂等）
   pnpm --filter @zhixing/pipeline import-regions    # 6 熟悉地区 + 10 省会（幂等）

   > M3 起数据文件带省级层（直辖市/港澳为省级链顶，普通城市挂省）。两个导入命令幂等，
   > 生产升级省市层级 = 直接重跑上面两条 import——存量链顶城市会被原地补挂/升级，
   > 不新建重复节点，足迹与风物卡无需迁移。

2. 全国铺底（每地 ≥3 张，分类轮转；~80 张，配额紧张可分天跑）：
   pnpm --filter @zhixing/pipeline batch -- --fill 3 --delay 4000
3. 北京加深（样板间，每点 ≥5 张）：
   pnpm --filter @zhixing/pipeline batch -- --fill 5 --city 北京市 --delay 4000
4. 抽查复核：后台 http://localhost:3000/cards 通读新卡——开头非百科腔、有细节锚点、
   传说带"相传"、来源非空；不合格的直接「下架」，跑 batch 会自动补足缺口。
5. TestFlight 门槛（不达标就继续跑 batch）：
   - 总卡数 ≥ 80；北京每点 ≥5；六地每点 ≥3；省会每城 ≥3
   - 「AI 整理·待复核」标识由 iOS 端展示，M1 不要求全部人工复核（规格书 §3.2）

## 二、日常维护（三个循环）

batch 是唯一需要记住的补卡命令：它扫描**全部地点**（含后台手工新建的），统计每地
未下架卡数，对不足 `--fill` 目标的地点自动生成补齐，分类按 习俗/吃食/方言/掌故/
地名由来 轮转。幂等、可随时重跑，失败的卡下次重跑补上。

    pnpm --filter @zhixing/pipeline batch -- --fill 3 --delay 4000
    # 可选：--city 北京市（只补该市及其下属点）；--limit N（本次最多生成 N 张）；--no-web-search

1. **新增地点 → 补卡**：后台「地点」页（/places）新建，高德选点（坐标已是 GCJ-02，
   直接入库）→ 跑一次 batch，新地点会被自动补到目标卡数。
   注意：管线按**地点名**匹配地点，重名时命中哪个不确定——新建时避免与现有地点重名。
   **省市自动挂链**：搜索选点/地图点选会识别所属省市，表单出现「将自动挂入：某省 →
   某市 → 本点位」提示，保存时省市不存在则自动创建、存在则复用——不再需要手工预建
   省市节点。手动改选父级或点「不挂链」即退出自动模式；直辖市/特区只挂单个省级链顶
   （与库内北京市形态一致）。自动新建的省/市坐标暂取该点位坐标，如需精确中心可在
   地点页再编辑。
2. **复核 / 下架 → 自动补缺**：后台「风物卡」页（/cards）按地点通读，质量标准同上
   第 4 步；合格的「标记已复核」（AI_GENERATED → REVIEWED），不合格的「下架」
   （RETIRED），下次 batch 自动补足缺口。
   注意：下架的语义是**停止分发，不是撤回**——地点页立即不再返回该卡，但已收藏该卡
   的用户仍能从收藏列表打开全文（详情接口不过滤 RETIRED）。内容有硬伤需彻底撤回时，
   目前只能直接改库，或等后续实现硬删除。
3. **按需补内容**：后台「搜索缺失」页（/search-misses）沉淀了"用户搜了但库里没有"
   的词，按次数倒序——高频词值得补的，先按循环 1 建地点，batch 会跟着把卡配齐。
   不盲目铺量，按真实需求补（规格书的原则）。

## 三、手工建卡 / 改卡（后台暂无表单，直接调 API）

人工撰写精品卡、修正 AI 稿错别字等场景走 admin API，凭 ADMIN_TOKEN
（dev 默认 dev-admin-token）：

    # 新建（category 取 CUSTOMS/FOOD/DIALECT/ANECDOTE/PLACE_NAME 之一）
    curl -X POST http://localhost:8787/admin/cards \
      -H "Authorization: Bearer dev-admin-token" -H "Content-Type: application/json" \
      -d '{"placeId":"<地点id>","category":"ANECDOTE","title":"……",
           "sources":["……"],"blocks":[{"type":"TEXT","text":"……"}]}'

    # 修改（title / sources / blocks 任选；传 blocks 时整组替换、顺序即数组顺序）
    curl -X PATCH http://localhost:8787/admin/cards/<卡id> \
      -H "Authorization: Bearer dev-admin-token" -H "Content-Type: application/json" \
      -d '{"title":"新标题"}'

地点 id 可在后台地点详情页 URL 中拿到。状态流转（复核/下架）用后台按钮即可，
无需调 API。

脚本批量建点也可走同一自动挂链：`POST /admin/places` 传 `ancestors`（链顶在前，
`[省]` 或 `[省,市]`，直辖市/特区只传单个 `PROVINCE` 节点），省市按名幂等
find-or-create——已有节点只复用不修改，新建祖先未传坐标时回落该点位坐标：

    curl -X POST http://localhost:8787/admin/places \
      -H "Authorization: Bearer dev-admin-token" -H "Content-Type: application/json" \
      -d '{"name":"趵突泉","level":"POI","lat":36.6614,"lng":117.0125,
           "ancestors":[{"name":"山东省","level":"PROVINCE"},{"name":"济南市","level":"CITY"}]}'

`ancestors` 与 `parentId` 互斥（同给 400 conflicting_parent）。

## 成本记录

每张卡 1 次检索 + 1 次成稿调用；失败会跳过，重跑 batch 幂等补齐。
