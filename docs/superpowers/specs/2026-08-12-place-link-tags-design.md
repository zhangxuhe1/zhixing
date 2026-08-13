# 网友攻略更名「网友分享」并引入外链内容标签

2026-08-12 起草。地点抽屉第二分栏「网友攻略」（[2026-07-17 spec](2026-07-17-place-links-tab-design.md) 升级为独立分栏，数据模型见 [2026-07-15 M3 地点域 spec](2026-07-15-m3-place-domain-design.md)）目前把感受完全不同的外链混在一个名字过窄的列表里：

- **实用攻略**：路线、交通、预约、费用、避坑——回答「去了怎么玩」（如 B 站《200 元穷游香港》类攻略视频）；
- **旅行记录**：博主第一人称的旅行过程、Citywalk、氛围影像——回答「想不想去」（如抖音旅行 vlog）；
- 此外存量中还出现了少量**深度讲解**类内容（第三人称讲地点历史/人文/地理）。

三类内容点开后的体验差异很大，但分栏名「网友攻略」只罩得住第一类，且用户点开前无从预判。本设计做两件事：

1. 分栏更名为**「网友分享」**——同时罩住「怎么玩」「什么感觉」「为什么」三端，保留「网友」二字承载的「站外创作者创作、非知行自产」信号（链接仍由管理员逐条挑选，知行对精选标准负责）。
2. 引入**管理端自主维护的外链内容标签**：新表 `PlaceLinkTag`（标签字典，后台增删改），`PlaceLink` 挂一个可空标签。管理后台可管理标签、给每条外链打标；App 端在链接行上渲染一枚安静的标签 chip，用户点开前一眼看出内容类型。

改动覆盖 DB / API / 管理端 / iOS，不新增分栏，不改变链接行的打开行为。

> 本设计取代暂存区旧方案（2026-07-30 spec / 2026-08-09 plan，已废弃删除）。旧方案用代码维护的五值枚举 `kind` 承载分类，并为存量回填设计了带数据库指纹与 SHA-256 冻结清单的 CLI。本版否决枚举路线：产品诉求恰是**运营可自主扩展的开放标签集**（增删标签不改代码、不发版），字典表是它的直接形态；存量仅 79 条链接，人工在管理后台打标即可，无需回填工具链。旧方案中的有效发现（更名论证、URL 空白数据质量问题、排序稳定性、管理端读鉴权接口）本版全部继承。

## 存量数据事实（2026-08-08 实测，引自旧方案普查）

| 指标 | 实测 |
| --- | --- |
| 外链总数 | 79 条，分布在 47 个地点 |
| 单地点最多 | 4 条 |
| 平台分布 | B 站 23 / 抖音 56 |
| URL 首尾含空白 | 21 条（均为抖音短链） |

两个影响设计的结论：

1. 单地点链接只有个位数，**标签的价值不在整理长列表，而在给每条外链一个「点开会看到什么」的预期**——所以 App 端用行内 chip 而非分组标题，不引入分组渲染的复杂度。
2. 21 条现网 URL 带尾随空白。Foundation 会把它编码成 `%20`，目前靠平台容错仍能跳转，但不应成为数据契约。本版三处修复：API 入口 zod `trim`、migration 一次性清洗存量、iOS `open(_:)` 打开前 trim（容错旧缓存）。

## 决策记录

| 议题 | 决策 | 理由 |
| --- | --- | --- |
| 标签载体 | **字典表 `PlaceLinkTag`，不用枚举** | 核心诉求是运营自主增删标签、免发版扩展。枚举每加一个值都要 migration + 全链路发版；字典表新增/改名即时生效，且改名自动全局同步（枚举做不到）。字典表的代价（多一张表、一个管理页）一次付清 |
| 单标签还是多标签 | **每条外链至多一个标签**（`tagId` 可空 FK，不建关联表） | 用户诉求是「一眼看出这是什么类型的视频」——语义是互斥的内容分类，不是自由组合的话题标签。单标签让 App 展示（一枚 chip）、管理端交互（一个下拉）都最简；将来出现真实的多标签消费场景再升级关联表（见「何时重新考虑」） |
| 未打标状态 | **`tagId = null` 即未打标，不设「未分类」标签** | null 天然表达「还没打标」，管理端按 `tag == null` 统计待办即可；不需要旧方案的 `UNCLASSIFIED` 运营态枚举，也不存在「运营态泄漏到公开 API」的问题——null 在公开 DTO 就是 `tag: null`，App 不渲染 chip，与今日形态一致。**null 的语义必须保持纯粹的「待处理」**：看过但不属于任何分类的内容归入运营自建的「其他」标签（见存量打标），不允许「审核过却留在 null」——否则未打标计数永远混着已审条目，无法作为可归零的完成判据 |
| 删除被引用的标签 | **拒绝（409 `tag_in_use`）+ DB `onDelete: Restrict` 兜底** | 误删标签会静默丢掉全部已打标注且不可恢复。管理端删除前可见引用计数，先把链接改标或清空再删；预检与删除之间的并发竞态由 FK Restrict 兜底转 409 |
| App 端展示方式 | **行内 chip，不分组** | 单地点最多 4 条链接，分组标题的信息密度收益为零，还要处理动态标签的组序、空组、未打标行归属等边界。chip 直接兑现「点开前预判类型」，且未打标行零变化 |
| chip 视觉 | **安静样式**：`caption2` + `.secondary` 前景 + `tertiarySystemFill` 胶囊 | 行内已有 cinnabar 实底平台徽章，标签是次级信息，不能成为第二处红色强调 |
| 公开 DTO 的标签形状 | **`tag: string \| null`（标签名）** | App 只消费名字；不下发 `tagId`（用户端无消费场景，公开契约保持最小）。标签名本身是公开内容的一部分，无隐私问题 |
| 管理端读取来源 | **新增 `GET /admin/places/:id/links`（requireAdmin），不再借公开 `/places/:id`** | 管理端编辑需要 `tagId`，公开 DTO 只有标签名。与其把管理字段塞进公开契约，不如按仓库「公私物理分离」原则给管理端专用读取；两侧共用同一排序常量，切换接口不改变列表顺序 |
| 存量打标的入口 | **新增管理端「外链总览」页（`GET /admin/links` 全量 + 前端「只看未打标」筛选）** | 79 条存量分布在 47 个地点，逐地点打开太低效。全量接口 + 本地筛选在当前量级下最简（无分页、无服务端筛选参数）；这个页面同时是日常巡查入口，不是一次性工具 |
| 存量回填方式 | **上线后人工在管理后台打标，不做回填脚本/CLI** | 79 条量级人工半小时可完成，且打标本来就要求人工打开内容判断；脚本除了搬运人工结论没有增量价值。打标进度由「外链总览」页的未打标计数直接可见 |
| 标签排序 | **`sortOrder` 字段（下拉选项与列表顺序）** | 标签建错顺序时（先建「记录」后建「攻略」）没有 sortOrder 就只能删了重建，而删除又被引用保护挡住；一个 int 字段的成本换来运营可控的展示顺序 |
| 部署协商机制 | **不做 capability 协商，改 runbook 为两段式启动** | 现有 runbook 的一次性 `up -d --build` 并**不**保证 DB→API→admin 顺序（compose 里 admin 不依赖 api，migration 又在 api 容器启动命令里执行），新 admin 可能先上、对旧 API 全面 404。修法不是恢复 capability 协商（单运营者自部署、窗口只有分钟级），而是把 docs/deploy.md 的升级命令拆成两段：先起 db/minio/api 并确认新接口就绪，再起 admin（见「兼容与上线」，随实施写进 runbook） |
| 存量 URL 空白 | **migration 一次性 `btrim` 清洗 + 入口 trim + iOS 打开前 trim** | 无判断的规范化清洗可以进 migration（与业务分类回填不同，后者才不该进 migration）；三处防御分别覆盖存量、新增与旧缓存 |
| 排序稳定性 | **公开与管理端共用 `PLACE_LINK_ORDER_BY = [sortOrder asc, createdAt asc, id asc]`** | 现状缺 `id` 第三键，`sortOrder` 与 `createdAt` 理论可撞；抽成共享常量顺带保证两侧接口顺序一致 |

## 数据模型

`packages/db/prisma/schema.prisma`：

```prisma
// 外链内容标签字典:管理端自由增删改(如"实用攻略""旅行记录"),重命名即时全局生效。
// 删除被引用标签由 API 预检 + FK Restrict 双层拒绝,防误删丢标注。
model PlaceLinkTag {
  id        String      @id @default(cuid())
  name      String      @unique
  sortOrder Int         @default(0) // 下拉选项与列表展示顺序
  links     PlaceLink[]
  createdAt DateTime    @default(now())
}
```

`PlaceLink` 增加：

```prisma
  tagId     String?
  tag       PlaceLinkTag? @relation(fields: [tagId], references: [id], onDelete: Restrict)
```

- migration 除 DDL 外，附一条幂等的存量 URL 清洗：`UPDATE "PlaceLink" SET "url" = btrim("url", E' \t\r\n') WHERE "url" <> btrim("url", E' \t\r\n')`。
- 存量行 `tagId` 落 `NULL`（未打标），新旧客户端展示均与今日一致，无强制回填。
- 无新增索引：单地点链接个位数，标签总量个位数，引用计数用 `_count` 聚合即可。
- **新表必须加进 TRUNCATE 清单**：`apps/api/test/helpers.ts`、`packages/db/test/*.ts` 五个文件、`apps/pipeline/test/{import,regions}.test.ts`（凡含 `"PlaceLink"` 的清单均补 `"PlaceLinkTag"`）。

## API 变更

**标签字典（新文件 `apps/api/src/routes/adminLinkTags.ts`，全部 requireAdmin）**

- `GET /admin/link-tags` → `[{ id, name, sortOrder, linkCount }]`，按 `sortOrder asc, createdAt asc, id asc`。`linkCount` 供删除防呆与打标进度展示。
- `POST /admin/link-tags` body `{ name, sortOrder? }`；`name` trim 后 1–12 字符；撞唯一约束 → 409 `duplicate_name`。
- `PATCH /admin/link-tags/:id` body `{ name?, sortOrder? }`（至少一个字段）；改名撞唯一 → 409。
- `DELETE /admin/link-tags/:id`：`linkCount > 0` → 409 `tag_in_use`（detail 带计数）；预检后的并发竞态由 FK Restrict（P2003）兜底转 409。

**外链打标（`apps/api/src/routes/adminPlaces.ts`）**

- `linkCreateSchema` 加 `tagId: z.string().nullish()`；`url` 改为 `z.string().trim().url().startsWith("https://").max(500)`。`linkPatchSchema` 由 partial 派生自动获得两者；`PATCH { tagId: null }` 表示取消标签。
- POST/PATCH 对非空 `tagId` 预检标签存在，不存在 → 400 `unknown_tag`；写入时撞 FK（P2003）同样转 400。
- `LINK_SELECT` 迁至共享模块并加 `tag: { select: { id: true, name: true } }`——管理端 DTO 的标签形状是 `{ id, name } | null`。
- 新增 `GET /admin/places/:id/links` → `{ id, name, level, ancestors, links }`，`links` 按 `PLACE_LINK_ORDER_BY` 稳定排序；管理端地点外链页改用本接口。
- 新增 `GET /admin/links` → `{ items }`，每项含 `LINK_SELECT` 字段 + `place: { id, path }`（path 为「省 · 市 · 地点」全路径）。路径组装先一次读全量 Place（当前 123 个）再内存上溯（10 跳保险丝），不做逐链接的 N+1；当前量级不分页。

**公开面（`apps/api/src/routes/places.ts`）**

- `/places/:id` 的 `links` DTO 逐字段加 `tag: l.tag?.name ?? null`；排序改用共享 `PLACE_LINK_ORDER_BY`。
- 公开 DTO 键集合固定为 `id / platform / title / url / sortOrder / tag`——不泄漏 `tagId / placeId / createdAt`，禁字段回归照旧。

**共享常量（新文件 `apps/api/src/placeLinks.ts`）**：`PLACE_LINK_ORDER_BY` 与 `LINK_SELECT`，公开详情、管理端详情、外链总览三处共用。

## 管理端

- **导航**（`app/layout.tsx`）：「地点库」后新增「外链」→ `/links`。
- **外链总览页**（新 `app/links/page.tsx`）：表格列 = 地点路径（链接到 `/places/:id`）/ 平台 / 标题 / 原链接 / 标签下拉；「只看未打标」复选框本地筛选；标题显示总数与未打标数；页头链接「管理标签 →」进 `/link-tags`。下拉 onChange → `PATCH /admin/links/:id { tagId }`。
- **标签管理页**（新 `app/link-tags/page.tsx`）：列表（名称 input onBlur 改名 / 排序 input onBlur 保存 / 引用计数 / 删除按钮，引用数 > 0 时禁用并提示）+ 新增表单。
- **地点外链页**（`app/places/[id]/page.tsx`）：读取改为 `GET /admin/places/:id/links`；表格加「标签」列（下拉，选项来自 `GET /admin/link-tags`，含「（无标签）」）；新增表单加标签下拉（默认无标签）；标题更名为「网友分享外链（N，未打标 M）」——未打标数从 `links` 派生，不另存状态。
- **写操作竞态防线（三页共同约定，四条规则一条不变量）**：
  1. 行级互斥：某行写请求在途时禁用该行全部控件（per-row busy）——同一链接/标签的连续操作被物理串行化；
  2. 新增表单有独立 **creating 锁**——`PlaceLink.url` 无唯一约束，慢网双击的重复创建只能在入口挡；
  3. 成功写入一律用**响应做函数式内存合并**（打标/改名/删除/新增；新增后按 `sortOrder` 稳定重排）；
  4. 可编辑输入（改名/排序）是**受控组件**（per-row draft），失败丢弃草稿即复位——不用 `defaultValue` + key 重挂载的技巧：PATCH 失败时服务端值不变、key 不变，输入框根本不会复位。
  **不变量：初始加载之后，整页 GET 只允许发生在页面级写锁（syncing）内**——仅两种情况回拉：排序成功后（组内真序在服务端 `createdAt`，本地推不出）与任何写失败后。写锁用**引用计数**实现：并发触发多次回拉时，最后一个回拉结束（finally 保证释放）才解锁——先完成者不得提前放行新写，否则仍在途的旧 GET 可能覆盖锁外新写。配套要求 **load() 原子提交且失败可见**：多 GET 页面先拿齐全部结果再一起提交 state，不留半份快照；load() 失败向上抛——初始加载失败停在错误页，回拉失败设置 error 后解锁（页面停留在旧快照，刷新自救），任何调用方不得在回拉完成后再清空 error。锁内发不出新写，「陈旧快照覆盖别行新值」失去存在条件。已知接受的残余：写锁生效前一瞬已在途的另一行写入可能被回拉快照错过——数据库始终正确，仅显示短暂滞后，刷新即齐；单运营者低频工具，不再为此引入 mutation queue / loadGeneration / 全局 reconciliation。

## iOS 交互与界面

- 分段控件第二段：「网友攻略」→「网友分享」（`PlaceDrawer.DrawerSection.links` 的 rawValue，四字宽度不变）。
- `PlaceLink`（`Core/Models.swift`）加 `let tag: String?`——可选容错，旧服务端/旧缓存缺字段解码为 nil（与 `PlaceDetail.links` 同款兼容写法）。
- 链接行（`Place/PlaceLinksSection.swift`）：平台徽章后、标题前，`tag` 非 nil 时渲染一枚 chip——`caption2.weight(.semibold)`、`.secondary` 前景、`Color(.tertiarySystemFill)` 胶囊背景，刻意比 cinnabar 平台徽章安静。`tag == nil` 不渲染任何占位，行与今日完全一致。
- `open(_:)` 对 `link.url` 先 `trimmingCharacters(in: .whitespacesAndNewlines)` 再构造 URL 与 https 校验；不改变其余打开行为。
- 空态文案：eyebrow「网友分享」、标题「分享还在收集中」、正文「我们会陆续为这里挑选值得一看的旅行记录与实用攻略。」；失败文案「网友分享加载失败，请重试」。列表平铺、行样式、浏览器选择均不变。

## 兼容与上线

- **老 iOS + 新 API**：公开 DTO 多出的 `tag` 字段被 `JSONDecoder` 忽略，零影响。
- **新 iOS + 老 API / 旧缓存**：`tag` 缺失解码为 nil，不渲染 chip，等同今日。App Store 审核节奏与服务端发布互不约束。
- **DB → API → 管理端必须按序**：老 API 的 Prisma client 按旧模型显式列查询，对新列/新表零感知，先跑 migration 安全；管理端不得先于新 API 上线（新管理页会对 `/admin/link-tags` 等接口 404 报错）。**现有 runbook 的一次性 `up -d --build` 不保证这个顺序**——compose 里 admin 不依赖 api。本次随实施把 docs/deploy.md 现行「步骤」第 3、4 步一并改写为两段式：先 `up -d --build db minio api`，以**硬断言**把关——`/health` 通过且未带鉴权的 `GET /admin/link-tags` 状态码经 `test ... = 401` 断言（旧 API 是 404，401 即证明新接口已就位），断言失败脚本即中止、不得继续起 admin；通过后才 `up -d --build admin`。所有探测 curl 均带 `--connect-timeout`/`--max-time`，等待循环有界；原第 4 步的 `curl https://api.<域名>/health` 占位命令（不可执行）的验证职责并入硬断言，该步只保留浏览器验证 admin。
- 回滚：本次 DB 变更是纯加表/加列，回滚 API/管理端二进制即可，列与已打标注保留，老代码零感知。

## 存量打标（上线后人工运营）

1. 管理后台 `/link-tags` 建初始标签，建议：**「实用攻略」「旅行记录」**；存量中已出现的第三类（历史/人文讲解）可同时建**「深度讲解」**，由运营定夺；遇到三类都不属于的内容时再建**「其他」**做兜底。
2. `/links` 页勾选「只看未打标」，逐条打开原内容判断后打标；未打标计数归零即完成。
3. 打标判据（继承旧方案附录，收进 docs/content-ops.md）：
   - **实用攻略**：路线、交通、预约、费用、时间安排、避坑、机位等可执行信息，核心价值是帮助行动；
   - **旅行记录**：第一人称旅行过程、旅行挑战，或无解说的沉浸影像 / Citywalk / 风景漫步，核心价值是感受与代入；
   - **深度讲解**：第三人称讲清一个地方的历史/人文/地理，核心价值是理解；
   - 同一内容跨类时按主要消费价值判断；仅凭标题无法判断的必须打开原内容；**看过且确实不属于以上三类的，归入自建的「其他」标签**（App 会显示「其他」chip，向用户传达「不是攻略也不是记录」，可接受）；**暂时拿不准的保持未打标**——它本来就还是待办，下次继续看。由此 `tagId = null` 始终只表示「待处理」，未打标计数归零 = 存量处理完成，完成判据可验证、不会混入已审条目。
4. 失效/无法访问的链接不打标，走既有的管理端删除流程。

## 测试

**`packages/db/test/schema.test.ts`** — 标签建档→外链挂标→读回的往返用例；`name` 唯一约束违约抛 P2002。

**`apps/api/test/adminLinkTags.test.ts`（新）** — 全部端点无鉴权 401；create/list（含 linkCount 与 sortOrder 顺序）/rename/duplicate 409/delete 204/delete-in-use 409/404；name 超长与空串 400。

**`apps/api/test/placeLinks.test.ts`** — 既有 DTO 键断言加 `"tag"`（逐字段防护按预期报警）。补：POST 带合法 `tagId` → 201 且响应 `tag: { id, name }`；公开 `/places/:id` 对已打标返回 `tag: 标签名`、未打标返回 `tag: null`，且序列化全文不含 `tagId`；`PATCH { tagId: null }` 取消标签；未知 `tagId` → 400 `unknown_tag`；URL 首尾空白被 trim 落库、trim 后非法仍 400；`GET /admin/places/:id/links` 无鉴权 401、有鉴权返回 ancestors 与带 `tag` 对象的 links、与公开详情同序；`GET /admin/links` 无鉴权 401、有鉴权返回全量含 `place.path`。

**iOS** — `InteractionDesignTests.testPlaceLinksIsAStandaloneDrawerSection` 两处硬编码字符串更新（`case links = "网友分享"`、「分享还在收集中」），补 chip 与 URL trim 的源码断言；`PlacePathTests` 补 `tag` 有值/缺失两个解码用例（缺失不崩、chip 数据为 nil）。

**回归** — `pnpm -C packages/db push:test` 后：`pnpm test`（root）、`pnpm -C apps/api exec vitest run`、`pnpm -C apps/admin build`、`scripts/ios-test.sh`；管理端三个页面人工走查（无自动化测试基建，维持仓库现状）。

## 何时重新考虑

- **多标签**：出现「同一链接确需同时挂两类」的真实运营案例 ≥ 5 条时，`tagId` 升级为关联表；届时同时决定 App 端多 chip 的展示与排序。
- **App 端按标签分组/筛选**：单地点某一标签下稳定 ≥ 8 条（当前单地点最多 4 条）时再考虑分组标题或筛选 chips；由届时的真实数据倒推形态。
- **外链总览分页与服务端筛选**：外链总量稳定超过 500 条时，`GET /admin/links` 加 cursor 分页与 `tagId` 查询参数（连带 `tagId` 索引）。
- **标签元信息**（颜色、图标、描述、打标人/时间）：出现多人协作或视觉区分诉求时再加列，当前一律不做。
- **独立审核状态**（如 `tagReviewedAt`）：若「已审核但不想展示任何 chip」成为真实诉求（即「其他」chip 被判定不可接受），或多人协作需要区分「漏审」与「已审」，再加列把「审核进度」与「展示分类」拆成两轴；当前由「其他」标签兜底 + 单人运营，不需要。

## 不做

- `kind` 枚举、`UNCLASSIFIED` 运营态、capability 协商——被字典表方案整体取代。
- 存量回填脚本/CLI、数据库指纹、冻结清单——79 条人工打标。
- 多标签关联表、标签颜色/图标、用户端标签筛选、分栏 tab 徽标。
- App 端分组渲染与分组标题。
- 用户提交外链、外链审核流、封面图抓取。
- 链接行样式与打开行为的其它改动。
