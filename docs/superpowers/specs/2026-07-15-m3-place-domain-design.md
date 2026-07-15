# M3 设计:地点域增强(省市层级 / 用户申请地点 / 地点外链)

日期:2026-07-15
状态:已评审待实施
前置:M0 / M1 / M2 已完成并上线(api.example.com)

## 背景

用户侧反馈与新想法梳理(2026-07-15 讨论),四条:

1. **省份统计恒为 0**:足迹页显示"2 城市 / 0 省份"。调研结论:`/me/stats` 的递归 CTE 归并算法本身正确(手工造省级节点的测试能算出 provinces=1),根因是**导入数据从未创建 PROVINCE 层**——`import-places.ts` / `import-regions.ts` 把所有城市建成 `parentId=null` 的链顶节点。同类问题:"随便走走"随机到的地点/卡片不显示位置路径,因为 Pin DTO 只有未解析的 `parentId`,iOS `Card` 模型未解码服务端已返回的 `place` 字段。
2. **用户无法在地图任意位置创建足迹**:只能挂已有地点。参照 tokyo.travoices.com(与本产品形态最接近的竞品):它是**纯受控地点库**——374 个地点全部从 258 位 YouTube 博主内容中挖掘,用户无建点入口;换来干净、有策展感的地图。但它覆盖度靠内容挖掘天然保障,咱们靠管理员手工录入,覆盖度是短板。
3. **给地点挂自媒体攻略链接**(小红书/B 站等),第一期只放链接。travoices 的地点详情页(引用列表:作者+标题+摘录+跳转)可作展示形态参照。
4. **账号密码登录**:低优先级。另有发现:会话 JWT 本身 180 天有效,"每次都要验证码登录"更可能是会话持久化问题(重点怀疑 Catalyst ad-hoc 签名导致 Keychain 读不回),应先查根因。

## 决策记录

| 议题 | 决策 | 理由 |
| --- | --- | --- |
| 足迹地点模式 | **受控库 + 用户申请新地点**(审核制) | 与足迹公开审核机制同构;解决覆盖度痛点;库不脏 |
| 申请功能开关 | **服务端 env 开关,默认开** | 前期数据不足开放申请,覆盖够了关掉控维护;切换低频,env 足够 |
| 外链维护方 | **仅管理员**(第一期) | 不叠加新审核负担;表结构预留用户提交的演进空间 |
| 密码登录 | **后置**,实现前先排查"频繁重登"根因 | 收益低(OTP+180 天会话);密码带来存储/找回/泄露成本 |
| 排期 | 本里程碑 = A+C+B;《足迹照片编辑闭环》计划顺延 | 三件事同在地点域,schema/DTO/admin 一次改到位 |

## 范围

**做**:A 省市层级修复+位置路径显示;B 用户申请新地点(含开关);C 地点外链。
**不做**:密码登录(后续独立里程碑);足迹照片编辑闭环(既有计划,顺延);外链的用户提交与审核;省级地图聚合视野。

---

## A. 省市层级修复 + 位置路径显示

Schema 不动(四级树已支持),改数据与 DTO。

### 数据(pipeline)

- `beijing-places.json` / `regions-places.json` 每个城市补 `province` 字段(如 济南市/德州市→山东省,东莞市→广东省,商丘市→河南省)。
- **直辖市与港澳(北京/香港/澳门)直接升为 `level=PROVINCE` 的链顶节点**,不再套省层。现有 CTE 的 `COALESCE(city_id, top_id)` 回退让它们**既算 1 省又算 1 城**,符合点亮地图类产品惯例。
- 省级节点必填坐标,取省会/中心坐标。
- 导入脚本升级(保持幂等):
  1. 数据文件声明的省不存在则创建(`level=PROVINCE, parentId=null`);
  2. 已存在的城市若 `parentId=null` 且数据文件声明了省,**update 补挂**;直辖市/港澳同理 update `level` 为 PROVINCE。
- **生产数据迁移 = 改完数据文件后重跑 import**,不写独立迁移脚本(补挂逻辑天然修复存量)。

### API

- `GET /places/:id`、`GET /places/random`、`GET /cards/:id`(其内嵌 place)DTO 增加 `ancestors: [{ id, name, level }]`,**顺序定死为从远到近(省 → 市 → 区)**,客户端 join(" · ") 即得"山东省 · 济南市"。仅含 id/name/level 三个无害字段。
- 全量 `GET /places/pins` **不加** ancestors(payload 膨胀,地图打点用不上)。
- `/me/stats` 零改动,数据补层后省份数字自动变对。

### iOS

- `PlaceDrawer` 地点名下方小字路径:如"山东省 · 济南市"(地点本身为市/省级时相应缩短)。
- `CardDetailView` 顶部加地点路径徽标。`GET /cards/:id` 服务端早已 `include: { place: true }`,iOS `Card` 模型补解码 `place` 字段即可(place 的展示路径需要 ancestors,随卡片接口一并返回)。
- `MeScreen` 统计无需改动。

### 测试

- pipeline:建省/补挂幂等(跑两遍结果一致);直辖市升级用例。
- api:`/places/:id` ancestors 顺序与内容;三级树数据下 `/me/stats` 的 provinces/cities 断言;公开 DTO 禁字段回归(ancestors 不引入 userId/lat/lng 等)。

---

## B. 用户申请新地点(受控库 + 申请审核)

### Schema

- 新枚举 `PlaceStatus: ACTIVE | PENDING | REJECTED`。
- `Place` 加列:`status PlaceStatus @default(ACTIVE)`(存量零迁移)、`createdByUserId String?`(null=官方录入;关联 User,onDelete SetNull)。
- **不建**独立 PlaceSubmission 表:足迹必须能立即挂新地点,分表会让 Footprint 外键分叉。

### 功能开关

- env `ZHIXING_PLACE_SUBMISSION`(config.ts 给 dev 默认值,**默认开**)。
- 新增 `GET /config`(requireUser):`{ placeSubmission: boolean }`。iOS 据此显示/隐藏入口;后续客户端开关统一走这里。
- `POST /places` 服务端硬校验:开关关闭返回 403 `place_submission_disabled`(不能只靠客户端藏入口)。

### 用户流程(iOS)

- 入口 1:**地图长按任意位置**(Catalyst 为右键/长按触控板)→ "在此创建地点" → 表单只填名称(坐标已定)。
- 入口 2:足迹选点面板(PlacePickerSheet)与搜索无结果处,"没找到?创建新地点"。
- 创建后立即可挂足迹。自己的 PENDING 点在地图上用**虚线灰 pin + "审核中"徽标**;REJECTED 点显示"未通过"样式(其上足迹仍可见,用户可编辑足迹改挂他点)。

### 服务端规则

- `POST /places`(requireUser):body `{ name, lat, lng }`(zod:名称 1–50 字,坐标合法范围)。建 `status=PENDING, createdByUserId=me`。
- **父级自动猜**:按坐标找最近的 CITY 级节点挂为 parent(距离阈值常量,建议 150km;超出则 parentId=null),管理员审核时可改。用户不需要懂行政区划。
- 防滥用:**每用户每日建点上限常量**(定 10,放路由文件顶部,类似 `EMAIL_CODE` 模式);撞 `@@unique([name, parentId])` 返回 409 `place_exists` 并附已有地点 id,iOS 引导直接选用。
- 可见性(统一进 `visibility.ts` 管理,仿 `PUBLICLY_VISIBLE`):
  - 用户面 pins / 搜索 / 选点:`ACTIVE` + **自己的** PENDING/REJECTED(REJECTED 不进搜索与选点,仅 pins 保留以免足迹成孤儿)。
  - 公开面(public.ts 全部端点):**只见 ACTIVE**,PENDING/REJECTED 永不出现。
- **挂 PENDING/REJECTED 地点的足迹不能申请公开**:申请公开端点校验 `place.status === 'ACTIVE'`,否则 400 `place_pending`。iOS 提示"地点审核通过后才能公开足迹"。
- 统计:`/me/stats` 不看 place.status(私人统计,记录不打折);PENDING 点无父级时按链顶回退算 1 城,审核补挂后自动归正。
- pipeline `batch --fill` 只给 ACTIVE 地点生成风物卡。

### Admin 审核队列(新页面)

PENDING 列表(名称/坐标/申请人/时间),三个操作:

- **通过**:可改名、改挂父级 → `ACTIVE`,全网可见。
- **合并**:选目标地点 → 事务内把该点全部足迹(防御性地含 cards/links)迁到目标,删除待审点。申请者无感。
- **拒绝**:→ `REJECTED`,足迹保留私有。

通知:第一期不做推送,用户下次打开 App 看状态。

### 测试

- 建点:PENDING+createdBy;每日上限;重名 409;开关关闭 403;坐标非法 400。
- 可见性隔离:A 看不到 B 的 PENDING;公开面回归(PENDING/REJECTED 出现即失败)。
- 公开拦截:挂 PENDING 足迹申请公开 → 400 `place_pending`。
- admin:通过/合并/拒绝;合并后足迹 placeId 迁移、统计变化、原点消失。

---

## C. 地点外链(管理员维护)

### Schema

新表 `PlaceLink`:

```prisma
model PlaceLink {
  id        String       @id @default(cuid())
  placeId   String
  place     Place        @relation(fields: [placeId], references: [id], onDelete: Cascade)
  platform  LinkPlatform
  title     String
  url       String
  sortOrder Int          @default(0)
  createdAt DateTime     @default(now())

  @@index([placeId])
}

enum LinkPlatform {
  XIAOHONGSHU
  BILIBILI
  DOUYIN
  WEIBO
  OTHER
}
```

独立表而非 Place 上的 JSON:排序、增删、未来"用户提交+审核"演进都不再动 schema;"N 篇攻略"也可成为地点热度信号(travoices 的"N 次提及"模式)。

**新表必须加进 TRUNCATE 列表**:`apps/api/test/helpers.ts` 与 `packages/db/test/*.ts`。

### API

- admin:`POST /admin/places/:id/links`、`PATCH /admin/links/:id`、`DELETE /admin/links/:id`(requireAdmin)。zod:url 必须 `https://`;title 1–100 字。
- 读:`GET /places/:id` 一并返回 `links`(按 sortOrder)。公开面地点详情同样可带(无隐私字段)。

### iOS

`PlaceDrawer` 加"网友攻略"区块:平台图标+标题列表,点击跳系统浏览器(iOS 用 SFSafariViewController,Catalyst 打开默认浏览器)。无链接时区块整体不渲染。

### Admin

地点详情页加链接管理:增删、调序。

### 测试

非 admin 403;http/伪协议 url 拒绝;地点 DTO 含 links 且公开禁字段回归通过。

---

## 数据模型变更汇总

| 变更 | 内容 |
| --- | --- |
| 枚举 | 新增 `PlaceStatus`、`LinkPlatform` |
| Place | 加 `status`(默认 ACTIVE)、`createdByUserId?` |
| 新表 | `PlaceLink`(记得补两处 TRUNCATE 列表) |

## API 变更汇总

| 端点 | 变更 |
| --- | --- |
| `GET /config` | 新增,下发 `{ placeSubmission }` |
| `POST /places` | 新增,用户申请地点(requireUser,开关硬校验) |
| `GET /places/:id` | DTO 加 `ancestors`、`links` |
| `GET /places/random` | DTO 加 `ancestors` |
| `GET /cards/:id` | 内嵌 place 加 `ancestors`(卡片详情显示位置) |
| `GET /places/pins` / 搜索 | 过滤规则改为 ACTIVE + 自己的待审点 |
| 足迹申请公开 | 校验 `place.status=ACTIVE` |
| `/admin/places/:id/links` 等 | 新增,外链 CRUD |
| admin 地点审核(通过/合并/拒绝) | 新增 |

## 实施顺序建议

1. **A**(数据修复,用户可见 bug,独立);
2. **C**(外链,小块快赢,只加不改);
3. **B**(申请地点,最大块,依赖 A 的树完整性让"父级自动猜"更准)。

每步内部遵循仓库惯例:API 任务跑 `pnpm -C apps/api exec vitest run` 后提交;schema 变更后 `pnpm -C packages/db push:test`;iOS 改动跑 `scripts/mac-dev.sh` 走查。

## 后置事项(不在本里程碑)

- 密码登录:实现前先排查"频繁要求重新登录"的根因(重点:Catalyst ad-hoc 签名导致 Keychain 会话丢失)。
- 《足迹照片编辑闭环》(docs/superpowers/plans/2026-07-13-footprint-photo-editing.md):顺延至 M3 后。
- 外链用户提交与审核、外链数量作为地点热度信号。
