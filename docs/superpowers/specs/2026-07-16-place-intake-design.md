# 地点录入闭环设计（管理端建点 + 用户提报工单）

2026-07-16 · 承接 [2026-07-15 M3 地点域 spec](2026-07-15-m3-place-domain-design.md) 的"继续使用受控地点库"决策（revert 55aec90 之后），补全地点库的**录入侧**：管理员如何高效建细粒度点位，用户如何以最低成本参与线索供给。参考产品 travoices（纯策展点位，535 点来自管理员整理博主内容，用户不能建点）。

## 决策记录

| 议题 | 决策 | 理由 |
| --- | --- | --- |
| 点位粒度 | 可以做细（店铺级 POI），但**细点位只由策展侧生产**（管理端/pipeline） | 粒度是内容运营节奏问题；上次失误在"谁生产"而非"多细" |
| 用户参与形态 | **线索工单（PlaceSuggestion），不是地点实体** | 实体带状态机会渗透 pins/搜索/公开面/pipeline 全读路径（被撤方案 3248 行的根源）；工单唯一读者是管理端，零渗透 |
| 坐标系 | **全库统一 GCJ-02** | iOS MapKit 大陆底图即 GCJ-02，标注零转换对齐；管理端高德选点原生 GCJ-02；全链路无转换代码 |
| 排期 | 第一期（管理端建点/编辑）立即做；第二期（用户提报）**只定设计，缓建** | 管理端是确定要还的债（目前建点只能跑 pipeline）；用户侧等真实用户信号，避免重蹈零用户阶段做用户功能的覆辙 |

## 范围

**第一期做**：管理端地点新建/编辑 UI（高德地图选点）；`PATCH /admin/places/:id`；既有 POST 加固；坐标系约定落文档。
**第二期做（缓建）**：PlaceSuggestion 工单表；用户提报端点；管理端线索队列与事务性采纳；iOS 足迹撰写器提报入口。
**不做**：用户直接创建地点（维持 places.test.ts 守卫）；地点删除（已挂卡/足迹语义复杂，清理走 DB）；长按地图建点入口；用户查看自己提报列表；外链用户提交；存量粗点位坐标迁移。

---

## 与被撤方案的对照（决策依据存档）

| | 被撤方案（用户建实体，55aec90 撤除） | 本方案（用户交线索） |
| --- | --- | --- |
| 提交产物 | Place 实体（PENDING 状态机） | 工单一张（名字+坐标+备注），不是地点 |
| 地图可见性 | 本人可见待审点，规则渗透 pins/搜索/公开面/pipeline | 任何地图不出现，零渗透 |
| Schema | Place 加 status/createdById/枚举 | Place 一字不动，独立 PlaceSuggestion 表 |
| 管理端 | 审核队列四操作（通过/改父/合并/拒绝） | 线索两操作（采纳/忽略） |
| 风控 | 远程开关+每日上限+重名引导 | 仅每日上限；最坏情况=队列垃圾工单，删掉即可 |

---

## 第一期：管理端建点/编辑

### 坐标系约定

- 全库 Place.lat/lng 声明为 **GCJ-02**，写入 schema.prisma 的 Place 注释与 CLAUDE.md 一行。
- 存量 44 个市/区级点位偏差不敏感，不迁移；今后细 POI 全部经地图选点录入。
- FootprintPhoto 的 EXIF 坐标是 WGS-84 私有数据，不上公开地图，本期不动；未来私人地图若要精确显示再单独立项。
- iOS 端 MapKit 在大陆取到/展示的坐标即 GCJ-02 系，与库内一致，客户端零改动。

### API（apps/api/src/routes/adminPlaces.ts）

- 新增 `PATCH /admin/places/:id`（requireAdmin）：`name / intro / lat / lng / parentId / level` 局部更新，至少一个字段（同 linkPatchSchema 的 refine 手法）。
  - `parentId` 变更需校验：目标存在（否则 400 `unknown_parent`）、不是自身且不是自身后代（否则 400 `cyclic_parent`）——树上出环会让足迹页的递归 CTE 死循环。
  - 层级搭配（如 POI 挂 PROVINCE 下）不强校验，与既有 POST 行为一致，正确性交给管理员。
- 既有 `POST /admin/places` 加固：parentId 不存在返回 400 `unknown_parent`（现为 FK 炸 500）；同父重名返回 409 `duplicate_name`（现为 unique 冲突炸 500）。PATCH 重名同样 409。
- 错误形状遵循 `{ error, detail? }`；body 校验失败照旧 400 `invalid_body`。

### 管理端 UI（apps/admin/app/places/page.tsx）

- 只读表格升级：顶部"新建地点"按钮 + 每行"编辑"；表单字段：名称、层级（默认 POI）、父级选择（下拉，按名称过滤）、坐标、简介。
- **地图选点组件**：高德 JS SDK——地名搜索定位 → 地图点击/拖 pin → 坐标回填。key 走 `NEXT_PUBLIC_AMAP_KEY`（高德开放平台免费 Web 端 key；白名单不支持 localhost/IP/端口——开发 key 白名单留空，生产 key 白名单填 admin.example.com）。**未配 key 时退化为手动输入经纬度**，功能不断。
- 列表补"父级"列与层级筛选，建完即可核对。
- 沿用现有架构：纯客户端 fetch（lib/api.ts）+ 朴素 CSS，无服务端数据访问。

### 测试

- vitest 集成测试：PATCH 各字段生效、400 unknown_parent、400 cyclic_parent、409 duplicate_name、POST 加固回归；places.test.ts"无用户建点端点"守卫保持通过。
- admin 前端无测试基建（维持现状），浏览器走查验收。

---

## 第二期：用户提报新地点（工单制，缓建）

### 数据模型（packages/db/prisma/schema.prisma）

```prisma
enum SuggestionStatus { OPEN ADOPTED DISMISSED }

model PlaceSuggestion {
  id             String           @id @default(cuid())
  userId         String
  user           User             @relation(fields: [userId], references: [id])
  name           String
  lat            Float            // GCJ-02
  lng            Float
  note           String?          // 如"南门对面"
  status         SuggestionStatus @default(OPEN)
  footprintId    String?          // 等待迁移的足迹；无 FK，采纳时校验仍存在才迁移
  adoptedPlaceId String?
  createdAt      DateTime         @default(now())

  @@index([status, createdAt])
}
```

- Place 表一字不动；status 唯一读者是管理端，公开面/搜索/pins/pipeline 零感知。
- 落库时把表加进 apps/api/test/helpers.ts 与 packages/db/test/*.ts 两处 TRUNCATE 清单。

### 用户 API

- `POST /place-suggestions`（requireUser）：name + lat/lng + note? + footprintId?（校验足迹属于本人，否则 400）。
- 风控仅一条：每人每日上限（常量定义在路由模块，默认 10），超限 429 `daily_limit`。不设远程开关。
- 不提供用户侧列表/详情端点；足迹被自动迁移即反馈。

### 管理端：线索队列 + 事务性采纳

- 队列页列出 OPEN 工单：名称、坐标小图、备注、提交时间。
- `GET /admin/place-suggestions?status=OPEN`；两个动作端点：
  - `POST /admin/place-suggestions/:id/adopt`：body 为最终地点字段（可改名/选父级/微调坐标，默认预填工单值，level 默认 POI）。服务端**单事务**：建 Place → 工单标 ADOPTED 记 adoptedPlaceId → 若 footprintId 存在且足迹仍在，则迁移其 placeId 到新点。重名 409，管理员改名重试；两步式（先建点再标记）明确不做，避免中间失败留下悬挂 OPEN 工单导致重试建重名点。
  - `POST /admin/place-suggestions/:id/dismiss`：标 DISMISSED。
- 非 OPEN 工单再次 adopt/dismiss 返回 409 `already_resolved`。

### iOS 入口（唯一入口，不做长按建点）

- 足迹撰写器搜地点无结果时出现"没找到？提报这个新地点"：弹层内名称预填搜索词、小地图扎 pin（默认当前位置）、备注可选。
- 提交后足迹照常挂到用户选择的区/市级父地点，提示"已提报，采纳后足迹会自动移过去"。
- 提报绑定真实记录意图，天然过滤随手乱点；无需远程开关。

### 测试

- 提交/每日上限/足迹归属校验；adopt 事务成功路径、409 重名、足迹已删跳过迁移、already_resolved。
- 守卫：提交工单后断言 Place 计数不变（工单不建点）；公开端点禁字段回归照旧（本期不新增公开端点）。

### 启动条件

dmg 发布、有真实用户后，SearchMiss 或用户反馈出现"想记但库里没有"的真实信号，才动工。
