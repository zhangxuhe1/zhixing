# M3 地点域增强实施计划(省市层级 / 地点外链 / 用户申请地点)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐省级数据让统计归并生效并全端显示位置路径;给地点挂管理员维护的外部攻略链接;开放"用户申请新地点"审核制闭环(带运营开关)。

**Architecture:** 三段推进 A→C→B。A 纯数据+DTO(schema 零改动):导入脚本建省挂城(幂等补挂存量),API 吐 `ancestors` 祖先链,iOS 显示路径。C 新增 `PlaceLink` 表+admin CRUD+iOS 攻略区块。B 给 `Place` 加 `status/createdById`,复制足迹"私有立即可用+审核解锁公开"状态机:用户 POST 建 PENDING 点(父级按坐标自动猜),读面按 `visibility.ts` 统一收口,admin 队列做通过/合并/拒绝。

**Tech Stack:** Fastify 5 + Prisma + zod / vitest(真实 PG+MinIO,无 mock)/ SwiftUI + MapKit / Next.js 15 admin。

**Spec:** docs/superpowers/specs/2026-07-15-m3-place-domain-design.md

## Global Constraints

- ESM + TS strict + NodeNext:相对导入必须带 `.js` 后缀。
- 错误形状统一 `{ error: string, detail?: any }`;body 校验全走 zod,失败 400 `invalid_body`。
- 注释/文档/commit 中文,conventional commits(如 `feat(api): ...`)。
- 测试打真库:先 `pnpm db:up`;**schema 每次变更后必须 `pnpm -C packages/db push:test`**;新增表必须同步 `apps/api/test/helpers.ts` 与 `packages/db/test/*.ts`(5 个文件)及 `apps/pipeline/test/{import,regions}.test.ts` 的 TRUNCATE 列表。
- 每个 api 任务收尾跑 `pnpm -C apps/api exec vitest run`;pipeline 任务跑 `pnpm -C apps/pipeline exec vitest run`;iOS 任务跑 `scripts/ios-test.sh`,并跑 `scripts/mac-dev.sh` 走查。
- 公开面 DTO 逐字段组装,禁字段:userId/appleSub/lat/lng(足迹照片的)/精确 takenAt/email/subject。
- iOS 新增源文件后跑 `xcodegen generate`(project.yml 按目录 glob,新文件自动纳入)。
- 运营常量:每用户每日建点上限 **10**(24 小时滚动窗),父级自动猜半径 **150km**,用户建点层级 **POI**。

---

# 里程碑 A:省市层级修复 + 位置路径显示

### Task 1: 导入脚本建省挂城(数据文件 + 幂等补挂存量)

**Files:**
- Modify: `apps/pipeline/data/beijing-places.json`(1 处)
- Modify: `apps/pipeline/data/regions-places.json`(16 个城市条目)
- Modify: `apps/pipeline/src/import-places.ts`
- Modify: `apps/pipeline/src/import-regions.ts`
- Test: `apps/pipeline/test/import.test.ts`、`apps/pipeline/test/regions.test.ts`

**Interfaces:**
- Produces: 数据形状——直辖市/特区为 `level=PROVINCE` 链顶;普通城市 `parentId` 指向省节点;省节点 `level=PROVINCE, parentId=null`。`importPlaces`/`importRegions` 签名不变。
- 后续任务依赖:Task 2 的 ancestors、`/me/stats` 的省份数都建立在这个数据形状上。

- [x] **Step 1: 改数据文件**

`beijing-places.json`:city 对象的 `"level": "CITY"` 改为 `"level": "PROVINCE"`(北京是直辖市,自身即省级链顶)。

`regions-places.json`:每个城市条目按下表加字段。香港、澳门加 `"level": "PROVINCE"`(不加 province);其余城市加 `"province"` 对象(同省城市重复写同一对象,导入端按名幂等):

| 城市 | province.name | province.lat | province.lng |
| --- | --- | --- | --- |
| 德州市、济南市 | 山东省 | 36.6683 | 117.0201 |
| 东莞市、广州市 | 广东省 | 23.1291 | 113.2644 |
| 商丘市 | 河南省 | 34.7657 | 113.7532 |
| 西安市 | 陕西省 | 34.3416 | 108.9398 |
| 成都市 | 四川省 | 30.6570 | 104.0665 |
| 杭州市 | 浙江省 | 30.2741 | 120.1551 |
| 南京市 | 江苏省 | 32.0603 | 118.7969 |
| 武汉市 | 湖北省 | 30.5928 | 114.3055 |
| 长沙市 | 湖南省 | 28.2282 | 112.9388 |
| 昆明市 | 云南省 | 25.0453 | 102.7097 |
| 哈尔滨市 | 黑龙江省 | 45.7576 | 126.6424 |
| 兰州市 | 甘肃省 | 36.0611 | 103.8343 |

普通城市条目示例(香港/澳门则是 `"level": "PROVINCE"` 且无 province 字段):

```json
{ "name": "济南市", "lat": 36.651, "lng": 117.12, "intro": "家家泉水，户户垂杨",
  "province": { "name": "山东省", "lat": 36.6683, "lng": 117.0201 },
  "spots": [ ... 原样保留 ... ] }
```

- [x] **Step 2: 写失败测试(先跑红)**

`apps/pipeline/test/regions.test.ts` 整体替换为:

```ts
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, expect, test } from "vitest";
import { createPrisma } from "@zhixing/db";
import { importRegions } from "../src/import-regions.js";

const prisma = createPrisma(
  process.env.TEST_DATABASE_URL ?? "postgresql://zhixing:zhixing@localhost:5433/zhixing_test",
);
const dataPath = fileURLToPath(new URL("../data/regions-places.json", import.meta.url));

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "FootprintPhoto","Footprint","CardBlock","Card","Place","User","SearchMiss" RESTART IDENTITY CASCADE',
  );
});
afterAll(async () => prisma.$disconnect());

test("导入多地区:建省挂城、直辖市/特区为省级链顶、幂等", async () => {
  const first = await importRegions(prisma, dataPath);
  expect(first.cityCount).toBe(16);
  expect(first.spotCount).toBe(12);

  await importRegions(prisma, dataPath);
  // 12 省 + 16 城 + 12 街区(香港/澳门是省级链顶,不再另建省)
  expect(await prisma.place.count()).toBe(40);

  const shandong = await prisma.place.findFirstOrThrow({ where: { name: "山东省" } });
  expect(shandong.level).toBe("PROVINCE");
  expect(shandong.parentId).toBeNull();

  const jinan = await prisma.place.findFirstOrThrow({ where: { name: "济南市" } });
  expect(jinan.parentId).toBe(shandong.id);

  const spot = await prisma.place.findFirstOrThrow({ where: { name: "芙蓉街" } });
  expect(spot.parentId).toBe(jinan.id);

  const hk = await prisma.place.findFirstOrThrow({ where: { name: "香港" } });
  expect(hk.level).toBe("PROVINCE");
  expect(hk.parentId).toBeNull();
});

test("存量补挂:老库里链顶城市(parentId=null)重跑导入后挂到省下,不产生重复城市", async () => {
  // 模拟生产存量:济南市已作为链顶 CITY 存在,且下面已有街区
  const legacy = await prisma.place.create({
    data: { name: "济南市", level: "CITY", lat: 36.651, lng: 117.12 },
  });
  await prisma.place.create({
    data: { name: "芙蓉街", level: "DISTRICT", parentId: legacy.id, lat: 36.665, lng: 117.023 },
  });

  await importRegions(prisma, dataPath);

  const jinans = await prisma.place.findMany({ where: { name: "济南市" } });
  expect(jinans).toHaveLength(1); // 不重复建
  expect(jinans[0].id).toBe(legacy.id); // 就是原节点(足迹/卡不受牵连)
  const shandong = await prisma.place.findFirstOrThrow({ where: { name: "山东省" } });
  expect(jinans[0].parentId).toBe(shandong.id); // 补挂成功
});
```

`apps/pipeline/test/import.test.ts` 在文件末尾追加:

```ts
test("直辖市升级:存量北京市 CITY 链顶,重跑导入后升为 PROVINCE,节点复用", async () => {
  const legacy = await prisma.place.create({
    data: { name: "北京市", level: "CITY", lat: 39.9042, lng: 116.4074 },
  });
  const r = await importPlaces(prisma, dataPath);
  expect(r.city.id).toBe(legacy.id);
  expect(r.city.level).toBe("PROVINCE");
  expect(await prisma.place.count()).toBe(16); // 1 + 15,没有多出节点
});
```

同时把既有用例"导入北京地点库，幂等可重复执行"末尾追加一行断言:

```ts
  expect(first.city.level).toBe("PROVINCE");
```

- [x] **Step 3: 跑测试确认失败**

Run: `pnpm -C apps/pipeline exec vitest run test/regions.test.ts test/import.test.ts`
Expected: FAIL(count 40 拿到 28;level 仍是 CITY)

- [x] **Step 4: 实现导入脚本**

`apps/pipeline/src/import-places.ts` 整体替换为:

```ts
import { databaseUrl } from "./env.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPrisma, type Place, type PrismaClient } from "@zhixing/db";

type SeedFile = {
  // 直辖市数据文件直接声明 PROVINCE:自身即省级链顶,统计上"既算 1 省又算 1 城"
  city: { name: string; level: "CITY" | "PROVINCE"; lat: number; lng: number; intro?: string };
  spots: Array<{ name: string; lat: number; lng: number; intro?: string }>;
};

export async function importPlaces(
  prisma: PrismaClient,
  dataPath: string,
): Promise<{ city: Place; spotCount: number }> {
  const seed = JSON.parse(readFileSync(dataPath, "utf-8")) as SeedFile;

  // 顶层地点 parentId 为 null,复合唯一键对 null 不生效,用 findFirst+create 保证幂等
  let city = await prisma.place.findFirst({ where: { name: seed.city.name, parentId: null } });
  if (!city) {
    city = await prisma.place.create({ data: seed.city });
  } else if (city.level !== seed.city.level) {
    // 存量升级:老库把直辖市建成 CITY,重跑导入原地升为 PROVINCE(id 不变,足迹/卡不受牵连)
    city = await prisma.place.update({ where: { id: city.id }, data: { level: seed.city.level } });
  }

  for (const s of seed.spots) {
    await prisma.place.upsert({
      where: { name_parentId: { name: s.name, parentId: city.id } },
      update: { lat: s.lat, lng: s.lng, intro: s.intro },
      create: { ...s, level: "DISTRICT", parentId: city.id },
    });
  }
  return { city, spotCount: seed.spots.length };
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const prisma = createPrisma(databaseUrl);
  const dataPath = fileURLToPath(new URL("../data/beijing-places.json", import.meta.url));
  importPlaces(prisma, dataPath)
    .then((r) => console.log(`imported: ${r.city.name} + ${r.spotCount} spots`))
    .finally(() => prisma.$disconnect());
}
```

`apps/pipeline/src/import-regions.ts` 整体替换为:

```ts
import { databaseUrl } from "./env.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPrisma, type PrismaClient } from "@zhixing/db";

type RegionsFile = {
  cities: Array<{
    name: string; lat: number; lng: number; intro?: string;
    /** 直辖市/特区:自身即省级链顶,不挂省 */
    level?: "PROVINCE";
    /** 普通城市所属省(同省城市重复声明同一对象,按名幂等) */
    province?: { name: string; lat: number; lng: number };
    spots: Array<{ name: string; lat: number; lng: number; intro?: string }>;
  }>;
};

export async function importRegions(
  prisma: PrismaClient,
  dataPath: string,
): Promise<{ cityCount: number; spotCount: number }> {
  const seed = JSON.parse(readFileSync(dataPath, "utf-8")) as RegionsFile;
  let spotCount = 0;
  for (const c of seed.cities) {
    // 1) 省节点(可选):链顶 findFirst+create 幂等
    let provinceId: string | null = null;
    if (c.province) {
      let prov = await prisma.place.findFirst({
        where: { name: c.province.name, parentId: null },
      });
      if (!prov) {
        prov = await prisma.place.create({
          data: { name: c.province.name, level: "PROVINCE", lat: c.province.lat, lng: c.province.lng },
        });
      }
      provinceId = prov.id;
    }

    // 2) 城市节点:先按 (name, 目标父) 找;找不到再找存量链顶同名城做"补挂"
    //   (生产老数据把城市建成 parentId=null,重跑导入即完成迁移,不建重复节点)
    const level = c.level ?? "CITY";
    let city = await prisma.place.findFirst({ where: { name: c.name, parentId: provinceId } });
    if (!city && provinceId) {
      const legacy = await prisma.place.findFirst({ where: { name: c.name, parentId: null } });
      if (legacy) {
        city = await prisma.place.update({
          where: { id: legacy.id },
          data: { parentId: provinceId, level },
        });
      }
    }
    if (!city) {
      city = await prisma.place.create({
        data: { name: c.name, level, lat: c.lat, lng: c.lng, intro: c.intro, parentId: provinceId },
      });
    } else if (city.level !== level) {
      city = await prisma.place.update({ where: { id: city.id }, data: { level } });
    }

    for (const s of c.spots) {
      await prisma.place.upsert({
        where: { name_parentId: { name: s.name, parentId: city.id } },
        update: { lat: s.lat, lng: s.lng, intro: s.intro },
        create: { ...s, level: "DISTRICT", parentId: city.id },
      });
      spotCount++;
    }
  }
  return { cityCount: seed.cities.length, spotCount };
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const prisma = createPrisma(databaseUrl);
  const dataPath = fileURLToPath(new URL("../data/regions-places.json", import.meta.url));
  importRegions(prisma, dataPath)
    .then((r) => console.log(`imported: ${r.cityCount} cities + ${r.spotCount} spots`))
    .finally(() => prisma.$disconnect());
}
```

- [x] **Step 5: 跑测试确认通过**

Run: `pnpm -C apps/pipeline exec vitest run`
Expected: PASS(全部 pipeline 用例)

- [x] **Step 6: 本地 dev 库执行迁移并抽查**

```bash
pnpm --filter @zhixing/pipeline import-places
pnpm --filter @zhixing/pipeline import-regions
```

Expected: 输出 `imported: 北京市 + 15 spots` 与 `imported: 16 cities + 12 spots`。再抽查:

```bash
docker exec -i $(docker ps -qf name=db) psql -U zhixing -d zhixing -c \
  "SELECT name, level, \"parentId\" IS NULL AS is_top FROM \"Place\" WHERE level='PROVINCE' ORDER BY name;"
```

Expected: 北京市/香港/澳门 + 12 个省,均 is_top=t。

- [x] **Step 7: 提交**

```bash
git add apps/pipeline
git commit -m "feat(pipeline): 数据补省级层——建省挂城/直辖市升级,幂等补挂存量"
```

---

### Task 2: API 祖先链——/places/:id、/places/random、/cards/:id 吐 ancestors

**Files:**
- Create: `apps/api/src/placeAncestors.ts`
- Modify: `apps/api/src/routes/places.ts`
- Modify: `apps/api/src/routes/cards.ts`
- Test: `apps/api/test/places.test.ts`、`apps/api/test/pins.test.ts`、`apps/api/test/cards.test.ts`

**Interfaces:**
- Produces: `placeAncestors(prisma, startParentId: string | null): Promise<Array<{id: string; name: string; level: string}>>`——**顺序从远到近(省→市→区)**。`GET /places/:id` DTO 变为 `{ id, name, level, lat, lng, intro, ancestors }`(**children 字段移除**,全库无消费方);`GET /places/random` 在 Pin 形状上追加 `ancestors`;`GET /cards/:id` 的 `place` 变为 `{ id, name, level, lat, lng, ancestors }`。
- Consumes: Task 1 的三级树数据(测试自造,不依赖导入)。

- [x] **Step 1: 写失败测试**

`apps/api/test/places.test.ts`:把既有用例"创建并查询地点树"的最后两行断言

```ts
  const detail = await app.inject({ method: "GET", url: `/places/${cityId}` });
  expect(detail.json().children).toHaveLength(1);
```

替换为:

```ts
  const detail = await app.inject({ method: "GET", url: `/places/${cityId}` });
  expect(detail.json().ancestors).toEqual([]); // 链顶无祖先
  expect(detail.json()).not.toHaveProperty("children"); // M3 起 DTO 移除 children
```

并在文件末尾追加:

```ts
test("GET /places/:id 返回从远到近的祖先链", async () => {
  const prov = await app.prisma.place.create({
    data: { name: "山东省", level: "PROVINCE", lat: 36.67, lng: 117.02 },
  });
  const city = await app.prisma.place.create({
    data: { name: "济南市", level: "CITY", parentId: prov.id, lat: 36.65, lng: 117.12 },
  });
  const spot = await app.prisma.place.create({
    data: { name: "芙蓉街", level: "DISTRICT", parentId: city.id, lat: 36.665, lng: 117.023 },
  });

  const res = await app.inject({ method: "GET", url: `/places/${spot.id}` });
  expect(res.statusCode).toBe(200);
  expect(res.json().ancestors).toEqual([
    { id: prov.id, name: "山东省", level: "PROVINCE" },
    { id: city.id, name: "济南市", level: "CITY" },
  ]);
  // 逐字段 DTO:不外传 createdAt/parentId 之外的内部字段
  expect(Object.keys(res.json()).sort()).toEqual(
    ["ancestors", "id", "intro", "lat", "level", "lng", "name"].sort(),
  );
});
```

`apps/api/test/pins.test.ts` 末尾追加:

```ts
test("random 带祖先链", async () => {
  const prov = await app.prisma.place.create({
    data: { name: "北京市", level: "PROVINCE", lat: 39.9, lng: 116.4 },
  });
  const spot = await app.prisma.place.create({
    data: { name: "什刹海", level: "DISTRICT", parentId: prov.id, lat: 39.94, lng: 116.38 },
  });
  await app.prisma.card.create({
    data: {
      placeId: spot.id, category: "ANECDOTE", title: "银锭观山", sources: ["x"],
      blocks: { create: [{ order: 0, type: "TEXT", text: "a".repeat(60) }] },
    },
  });
  const res = await app.inject({ method: "GET", url: "/places/random" });
  expect(res.json().ancestors).toEqual([{ id: prov.id, name: "北京市", level: "PROVINCE" }]);
});
```

`apps/api/test/cards.test.ts`:找到断言 `expect(detail.json().place.name).toBe("什刹海");` 的用例,紧随其后追加:

```ts
  expect(detail.json().place.ancestors).toEqual([]); // makePlace 造的是链顶点
  expect(detail.json().place).not.toHaveProperty("createdAt"); // place 改为逐字段 DTO
```

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/api exec vitest run test/places.test.ts test/pins.test.ts test/cards.test.ts`
Expected: FAIL(无 ancestors 字段;仍有 children/createdAt)

- [x] **Step 3: 实现**

新建 `apps/api/src/placeAncestors.ts`:

```ts
import type { PrismaClient } from "@zhixing/db";

export type PlaceAncestor = { id: string; name: string; level: string };

/**
 * 沿 parentId 链向上收集祖先。返回顺序定死为「从远到近」(省 → 市 → 区),
 * 客户端 join(" · ") 即得 "山东省 · 济南市"。深度上限 10 防呆(树实际最深 4 层)。
 */
export async function placeAncestors(
  prisma: PrismaClient,
  startParentId: string | null,
): Promise<PlaceAncestor[]> {
  const chain: PlaceAncestor[] = [];
  let cursor = startParentId;
  for (let depth = 0; cursor && depth < 10; depth++) {
    const node = await prisma.place.findUnique({
      where: { id: cursor },
      select: { id: true, name: true, level: true, parentId: true },
    });
    if (!node) break;
    chain.push({ id: node.id, name: node.name, level: node.level });
    cursor = node.parentId;
  }
  return chain.reverse();
}
```

`apps/api/src/routes/places.ts`:头部加 `import { placeAncestors } from "../placeAncestors.js";`,替换 random 与 detail 两个路由:

```ts
  app.get("/places/random", { config: ipKeyedRateLimit }, async (_req, reply) => {
    const withContent = (await queryPins(app)).filter((p) => p.cardCount > 0);
    if (withContent.length === 0) return reply.code(404).send({ error: "no_content" });
    const pick = withContent[Math.floor(Math.random() * withContent.length)];
    return { ...pick, ancestors: await placeAncestors(app.prisma, pick.parentId) };
  });
```

```ts
  app.get("/places/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const place = await app.prisma.place.findUnique({ where: { id } });
    if (!place) return reply.code(404).send({ error: "not_found" });
    // 逐字段 DTO:children 自 M3 移除(全库无消费方),createdAt/parentId 不外传
    return {
      id: place.id,
      name: place.name,
      level: place.level,
      lat: place.lat,
      lng: place.lng,
      intro: place.intro,
      ancestors: await placeAncestors(app.prisma, place.parentId),
    };
  });
```

`apps/api/src/routes/cards.ts`:头部加 `import { placeAncestors } from "../placeAncestors.js";`,替换 `GET /cards/:id`:

```ts
  app.get("/cards/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const card = await app.prisma.card.findUnique({
      where: { id },
      include: { ...includeBlocks, place: true },
    });
    if (!card) return reply.code(404).send({ error: "not_found" });
    const { place, ...rest } = card;
    // 卡片详情需要显示位置路径:place 改为逐字段 DTO 并附祖先链(从远到近)
    return {
      ...rest,
      place: {
        id: place.id,
        name: place.name,
        level: place.level,
        lat: place.lat,
        lng: place.lng,
        ancestors: await placeAncestors(app.prisma, place.parentId),
      },
    };
  });
```

- [x] **Step 4: 跑全量 api 测试**

Run: `pnpm -C apps/api exec vitest run`
Expected: PASS

- [x] **Step 5: 提交**

```bash
git add apps/api
git commit -m "feat(api): 地点/卡片 DTO 附祖先链 ancestors——从远到近,detail 改逐字段组装"
```

---

### Task 3: iOS 位置路径显示(地点抽屉 + 卡片详情)

**Files:**
- Modify: `apps/ios/Zhixing/Core/Models.swift`
- Modify: `apps/ios/Zhixing/Place/PlaceDrawer.swift`
- Modify: `apps/ios/Zhixing/Place/CardDetailView.swift`
- Create: `apps/ios/Tests/PlacePathTests.swift`

**Interfaces:**
- Produces: `PlaceAncestor { id, name, level }`、`PlaceDetail { id, name, level, intro?, ancestors, pathText }`、`Card.place: CardPlaceRef?`(可选——`/places/:id/cards` 列表无此字段,必须容错)、`CardDetailView(card:placePathOverride:)`。
- Consumes: Task 2 的 `/places/:id`、`/cards/:id` DTO。

- [x] **Step 1: 写失败测试**

新建 `apps/ios/Tests/PlacePathTests.swift`:

```swift
import XCTest
@testable import Zhixing

final class PlacePathTests: XCTestCase {
    func testPathTextJoinsFarToNear() throws {
        let json = """
        {"id":"p3","name":"芙蓉街","level":"DISTRICT","intro":null,
         "ancestors":[{"id":"p1","name":"山东省","level":"PROVINCE"},
                      {"id":"p2","name":"济南市","level":"CITY"}]}
        """
        let detail = try APIClient.decoder.decode(PlaceDetail.self, from: Data(json.utf8))
        XCTAssertEqual(detail.pathText, "山东省 · 济南市")
    }

    func testPathTextNilWhenTopLevel() throws {
        let json = """
        {"id":"p1","name":"北京市","level":"PROVINCE","intro":null,"ancestors":[]}
        """
        let detail = try APIClient.decoder.decode(PlaceDetail.self, from: Data(json.utf8))
        XCTAssertNil(detail.pathText)
    }

    /// `/places/:id/cards` 列表不含 place 字段——Card 解码必须容错,否则风物卡列表整页崩。
    func testCardDecodesWithoutPlace() throws {
        let json = """
        {"id":"c1","title":"银锭观山","category":"ANECDOTE","status":"REVIEWED",
         "sources":[],"blocks":[]}
        """
        let card = try APIClient.decoder.decode(Card.self, from: Data(json.utf8))
        XCTAssertNil(card.place)
    }

    func testCardLocationTextFromEmbeddedPlace() throws {
        let json = """
        {"id":"c1","title":"银锭观山","category":"ANECDOTE","status":"REVIEWED",
         "sources":[],"blocks":[],
         "place":{"id":"p2","name":"什刹海",
                  "ancestors":[{"id":"p1","name":"北京市","level":"PROVINCE"}]}}
        """
        let card = try APIClient.decoder.decode(Card.self, from: Data(json.utf8))
        XCTAssertEqual(card.locationText, "北京市 · 什刹海")
    }
}
```

- [x] **Step 2: 跑 iOS 测试确认失败(编译错误即失败)**

Run: `scripts/ios-test.sh`
Expected: FAIL——`PlaceDetail`/`card.place` 不存在,编译不过。

- [x] **Step 3: 实现模型**

`apps/ios/Zhixing/Core/Models.swift` 中:

在 `struct Pin` 之后追加:

```swift
struct PlaceAncestor: Codable, Hashable {
    let id: String
    let name: String
    let level: String
}

/// `GET /places/:id` 的地点详情:抽屉头部路径与后续攻略区共用。
struct PlaceDetail: Codable {
    let id: String
    let name: String
    let level: String
    let intro: String?
    let ancestors: [PlaceAncestor]

    /// 从远到近的位置路径:"山东省 · 济南市";链顶(无祖先)为 nil,不渲染。
    var pathText: String? {
        ancestors.isEmpty ? nil : ancestors.map(\.name).joined(separator: " · ")
    }
}
```

`struct Card` 增加内嵌地点(在 `let blocks: [CardBlock]` 之后):

```swift
    /// 仅 `GET /cards/:id` 返回;`/places/:id/cards` 列表无此字段——必须可选容错。
    let place: CardPlaceRef?
```

并在 `Card` 内(categoryLabel 附近)追加:

```swift
    /// 卡面位置行:"北京市 · 什刹海"。无内嵌 place(列表来源)时为 nil,由调用方注入兜底。
    var locationText: String? {
        guard let place else { return nil }
        return (place.ancestors.map(\.name) + [place.name]).joined(separator: " · ")
    }
```

在 `Card` 之后追加:

```swift
struct CardPlaceRef: Codable {
    let id: String
    let name: String
    let ancestors: [PlaceAncestor]
}
```

注意:`Card` 手写了 `==`/`hash`(按 id),新增属性不影响;`Codable` 合成会自动把缺失的 `place` 解成 nil(可选属性)。

- [x] **Step 4: PlaceDrawer 加载详情并显示路径**

`apps/ios/Zhixing/Place/PlaceDrawer.swift`:

状态区追加:

```swift
    @State private var placeDetail: PlaceDetail?
```

头部 `VStack(alignment: .leading, spacing: 2)` 里 `Text(pin.name)` 之后追加:

```swift
                            if let path = placeDetail?.pathText {
                                Text(path)
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
```

`.task { await loadCards() }` 改为:

```swift
            .task {
                async let cards: Void = loadCards()
                async let detail: Void = loadDetail()
                _ = await (cards, detail)
            }
```

文件末尾 `loadCards()` 旁新增:

```swift
    private func loadDetail() async {
        // 路径属锦上添花:失败静默(nil 不渲染),不打断风物卡主内容
        placeDetail = try? await APIClient.shared.get("/places/\(pin.id)")
    }
```

卡片跳转传入抽屉上下文兜底路径,`navigationDestination` 改为:

```swift
            .navigationDestination(for: Card.self) {
                CardDetailView(card: $0, placePathOverride: drawerLocationText)
            }
```

并新增计算属性:

```swift
    /// 抽屉里打开的卡片自身不带 place(列表接口)——用抽屉已知的路径+地点名兜底。
    private var drawerLocationText: String {
        if let path = placeDetail?.pathText { return "\(path) · \(pin.name)" }
        return pin.name
    }
```

- [x] **Step 5: CardDetailView 显示位置行**

`apps/ios/Zhixing/Place/CardDetailView.swift`:

属性区 `let card: Card` 之后追加:

```swift
    var placePathOverride: String? = nil

    private var locationText: String? { card.locationText ?? placePathOverride }
```

分类徽标 `HStack(spacing: 8) { ... }` 之后(`Text(card.title)` 之前)插入:

```swift
                    if let locationText {
                        Label(locationText, systemImage: "mappin.and.ellipse")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
```

`FavoritesScreen` 的 `CardDetailView(card: $0)` 不需要改:收藏详情走 `GET /cards/:id`,`card.place` 已带路径。

- [x] **Step 6: 跑 iOS 测试**

Run: `scripts/ios-test.sh`
Expected: PASS

- [x] **Step 7: Catalyst 走查**

Run: `scripts/mac-dev.sh`
验证:点开济南某街区抽屉,名称下出现"山东省 · 济南市";"随便走走"落点后抽屉同样带路径;点进卡片详情看到位置行;收藏页打开卡片同样有位置行。

- [x] **Step 8: 提交**

```bash
git add apps/ios
git commit -m "feat(ios): 地点抽屉与卡片详情显示省市路径"
```

---

# 里程碑 C:地点外链(管理员维护)

### Task 4: PlaceLink 表 + TRUNCATE 列表维护

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Modify: `apps/api/test/helpers.ts`
- Modify: `packages/db/test/identity.test.ts`、`schema.test.ts`、`seed.test.ts`、`seed-extras.test.ts`、`m2-models.test.ts`(TRUNCATE 行)
- Modify: `apps/pipeline/test/import.test.ts`、`apps/pipeline/test/regions.test.ts`(TRUNCATE 行)
- Test: `packages/db/test/schema.test.ts`

**Interfaces:**
- Produces: `PlaceLink { id, placeId, platform: LinkPlatform, title, url, sortOrder, createdAt }`,`Place.links: PlaceLink[]`,`enum LinkPlatform { XIAOHONGSHU BILIBILI DOUYIN WEIBO OTHER }`。

- [x] **Step 1: schema 变更**

`packages/db/prisma/schema.prisma`:`IdentityProvider` 枚举之后追加:

```prisma
enum LinkPlatform {
  XIAOHONGSHU
  BILIBILI
  DOUYIN
  WEIBO
  OTHER
}
```

`Place` 模型的 `footprints Footprint[]` 之后追加一行:

```prisma
  links      PlaceLink[]
```

`Place` 模型之后追加:

```prisma
// 地点外链(小红书/B 站等攻略帖):第一期仅管理员维护;独立表而非 JSON,
// 排序/增删与未来"用户提交+审核"演进都不再动 schema。
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
```

- [x] **Step 2: 迁移 + 测试库建表**

```bash
pnpm --filter @zhixing/db exec prisma migrate dev --name place-links
pnpm -C packages/db push:test
```

Expected: 迁移生成且应用成功。

- [x] **Step 3: 八处 TRUNCATE 列表加 "PlaceLink"**

以下文件的 TRUNCATE 语句在 `"Place"` 前插入 `"PlaceLink",`(TRUNCATE 顺序无关紧要,统一插同一位置便于 review):

- `apps/api/test/helpers.ts`
- `packages/db/test/identity.test.ts` / `schema.test.ts` / `seed.test.ts` / `seed-extras.test.ts` / `m2-models.test.ts`
- `apps/pipeline/test/import.test.ts` / `apps/pipeline/test/regions.test.ts`

例(apps/api/test/helpers.ts):

```ts
    'TRUNCATE TABLE "Like","FootprintPhoto","Footprint","Trip","CardFavorite","CardReport","CardBlock","Card","PlaceLink","Place","User","Identity","EmailCode","SearchMiss" RESTART IDENTITY CASCADE',
```

- [x] **Step 4: 写模型往返测试**

`packages/db/test/schema.test.ts` 末尾追加:

```ts
test("PlaceLink 往返:挂地点、级联删除", async () => {
  const place = await prisma.place.create({
    data: { name: "什刹海", level: "DISTRICT", lat: 39.94, lng: 116.38 },
  });
  await prisma.placeLink.create({
    data: {
      placeId: place.id, platform: "XIAOHONGSHU",
      title: "什刹海 citywalk 路线", url: "https://example.com/x", sortOrder: 1,
    },
  });
  const links = await prisma.placeLink.findMany({ where: { placeId: place.id } });
  expect(links).toHaveLength(1);
  expect(links[0].platform).toBe("XIAOHONGSHU");

  await prisma.place.delete({ where: { id: place.id } }); // onDelete: Cascade
  expect(await prisma.placeLink.count()).toBe(0);
});
```

(注意该文件顶部 `prisma` 实例已存在,直接用。)

- [x] **Step 5: 跑 db + 全仓测试**

Run: `pnpm -C packages/db exec vitest run && pnpm test`
Expected: PASS(全仓,确认 TRUNCATE 无遗漏)

- [x] **Step 6: 提交**

```bash
git add packages/db apps/api/test/helpers.ts apps/pipeline/test
git commit -m "feat(db): PlaceLink 地点外链表 + LinkPlatform 枚举"
```

---

### Task 5: 外链 API——admin CRUD + 地点详情带 links

**Files:**
- Create: `apps/api/src/routes/adminPlaces.ts`
- Modify: `apps/api/src/routes/places.ts`(移走 POST /admin/places;detail 带 links)
- Modify: `apps/api/src/app.ts`(注册 adminPlacesRoutes)
- Test: `apps/api/test/placeLinks.test.ts`(新建)

**Interfaces:**
- Produces: `POST /admin/places/:id/links`(201 → `{ id, platform, title, url, sortOrder }`)、`PATCH /admin/links/:id`、`DELETE /admin/links/:id`(204);`GET /places/:id` DTO 追加 `links: [{ id, platform, title, url }]`(按 sortOrder asc, createdAt asc);`adminPlacesRoutes(app)` 承接原 `POST /admin/places`(行为不变)。
- Consumes: Task 4 的 PlaceLink 模型、Task 2 的 detail DTO。

- [x] **Step 1: 写失败测试**

新建 `apps/api/test/placeLinks.test.ts`:

```ts
import { afterAll, beforeEach, expect, test } from "vitest";
import { ADMIN_AUTH, resetDb, testApp } from "./helpers.js";

const app = testApp();
beforeEach(() => resetDb(app));
afterAll(async () => app.close());

async function makePlace() {
  return app.prisma.place.create({
    data: { name: "什刹海", level: "DISTRICT", lat: 39.94, lng: 116.38 },
  });
}

test("外链 CRUD 需要 admin;detail 按 sortOrder 返回", async () => {
  const place = await makePlace();

  const noAuth = await app.inject({
    method: "POST", url: `/admin/places/${place.id}/links`,
    payload: { platform: "XIAOHONGSHU", title: "路线", url: "https://example.com/a" },
  });
  expect(noAuth.statusCode).toBe(401);

  const b = await app.inject({
    method: "POST", url: `/admin/places/${place.id}/links`, headers: ADMIN_AUTH,
    payload: { platform: "BILIBILI", title: "B 站探店", url: "https://example.com/b", sortOrder: 2 },
  });
  expect(b.statusCode).toBe(201);
  const a = await app.inject({
    method: "POST", url: `/admin/places/${place.id}/links`, headers: ADMIN_AUTH,
    payload: { platform: "XIAOHONGSHU", title: "citywalk 路线", url: "https://example.com/a", sortOrder: 1 },
  });
  expect(a.statusCode).toBe(201);

  const detail = await app.inject({ method: "GET", url: `/places/${place.id}` });
  expect(detail.json().links.map((l: { title: string }) => l.title)).toEqual([
    "citywalk 路线", "B 站探店",
  ]);
  // 外链 DTO 逐字段:不外传 placeId/createdAt
  expect(Object.keys(detail.json().links[0]).sort()).toEqual(
    ["id", "platform", "sortOrder", "title", "url"].sort(),
  );
});

test("url 必须 https;非法 platform 400", async () => {
  const place = await makePlace();
  for (const url of ["http://example.com/a", "javascript:alert(1)", "not-a-url"]) {
    const res = await app.inject({
      method: "POST", url: `/admin/places/${place.id}/links`, headers: ADMIN_AUTH,
      payload: { platform: "OTHER", title: "x", url },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  }
  const badPlatform = await app.inject({
    method: "POST", url: `/admin/places/${place.id}/links`, headers: ADMIN_AUTH,
    payload: { platform: "TIKTOK", title: "x", url: "https://example.com" },
  });
  expect(badPlatform.statusCode).toBe(400);
});

test("PATCH 改排序与标题;DELETE 删除;地点不存在 404", async () => {
  const place = await makePlace();
  const created = await app.inject({
    method: "POST", url: `/admin/places/${place.id}/links`, headers: ADMIN_AUTH,
    payload: { platform: "OTHER", title: "旧标题", url: "https://example.com/a" },
  });
  const linkId = created.json().id as string;

  const patched = await app.inject({
    method: "PATCH", url: `/admin/links/${linkId}`, headers: ADMIN_AUTH,
    payload: { title: "新标题", sortOrder: 5 },
  });
  expect(patched.statusCode).toBe(200);
  expect(patched.json().title).toBe("新标题");

  const del = await app.inject({ method: "DELETE", url: `/admin/links/${linkId}`, headers: ADMIN_AUTH });
  expect(del.statusCode).toBe(204);
  expect(await app.prisma.placeLink.count()).toBe(0);

  const missing = await app.inject({
    method: "POST", url: "/admin/places/nope/links", headers: ADMIN_AUTH,
    payload: { platform: "OTHER", title: "x", url: "https://example.com" },
  });
  expect(missing.statusCode).toBe(404);
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/api exec vitest run test/placeLinks.test.ts`
Expected: FAIL(路由不存在 404)

- [x] **Step 3: 实现**

新建 `apps/api/src/routes/adminPlaces.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "../auth.js";

const levelEnum = z.enum(["PROVINCE", "CITY", "DISTRICT", "POI"]);

const createPlaceSchema = z.object({
  name: z.string().min(1),
  level: levelEnum,
  parentId: z.string().nullish(),
  lat: z.number(),
  lng: z.number(),
  intro: z.string().optional(),
});

const linkCreateSchema = z.object({
  platform: z.enum(["XIAOHONGSHU", "BILIBILI", "DOUYIN", "WEIBO", "OTHER"]),
  title: z.string().trim().min(1).max(100),
  url: z.string().url().startsWith("https://").max(500),
  sortOrder: z.number().int().min(0).optional(),
});

const linkPatchSchema = linkCreateSchema.partial().refine(
  (v) => Object.values(v).some((x) => x !== undefined),
  { message: "at least one field required" },
);

const LINK_SELECT = {
  id: true, platform: true, title: true, url: true, sortOrder: true,
} as const;

export async function adminPlacesRoutes(app: FastifyInstance) {
  // 自 places.ts 迁入,行为不变:管理员建点(官方录入)
  app.post("/admin/places", { preHandler: requireAdmin }, async (req, reply) => {
    const body = createPlaceSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    }
    const place = await app.prisma.place.create({
      data: { ...body.data, parentId: body.data.parentId ?? null },
    });
    return reply.code(201).send(place);
  });

  app.post("/admin/places/:id/links", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = linkCreateSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    }
    const place = await app.prisma.place.findUnique({ where: { id } });
    if (!place) return reply.code(404).send({ error: "not_found" });
    const link = await app.prisma.placeLink.create({
      data: { ...body.data, placeId: id },
      select: LINK_SELECT,
    });
    return reply.code(201).send(link);
  });

  app.patch("/admin/links/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = linkPatchSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    }
    const existing = await app.prisma.placeLink.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "not_found" });
    return app.prisma.placeLink.update({ where: { id }, data: body.data, select: LINK_SELECT });
  });

  app.delete("/admin/links/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await app.prisma.placeLink.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "not_found" });
    await app.prisma.placeLink.delete({ where: { id } });
    return reply.code(204).send();
  });
}
```

`apps/api/src/routes/places.ts`:
1. 删除 `POST /admin/places` 路由与 `createPlaceSchema` 常量,及 `requireAdmin` import(若无其他使用)。
2. `GET /places/:id` 改为带 links:

```ts
  app.get("/places/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const place = await app.prisma.place.findUnique({
      where: { id },
      include: { links: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] } },
    });
    if (!place) return reply.code(404).send({ error: "not_found" });
    return {
      id: place.id,
      name: place.name,
      level: place.level,
      lat: place.lat,
      lng: place.lng,
      intro: place.intro,
      ancestors: await placeAncestors(app.prisma, place.parentId),
      links: place.links.map((l) => ({
        id: l.id, platform: l.platform, title: l.title, url: l.url, sortOrder: l.sortOrder,
      })),
    };
  });
```

`apps/api/src/app.ts`:import 区加 `import { adminPlacesRoutes } from "./routes/adminPlaces.js";`,`app.register(placesRoutes);` 之后加 `app.register(adminPlacesRoutes);`。

- [x] **Step 4: 更新 Task 2 的 keys 断言**

`apps/api/test/places.test.ts` 中 detail 的逐字段断言改为:

```ts
  expect(Object.keys(res.json()).sort()).toEqual(
    ["ancestors", "id", "intro", "lat", "level", "links", "lng", "name"].sort(),
  );
```

- [x] **Step 5: 跑全量 api 测试**

Run: `pnpm -C apps/api exec vitest run`
Expected: PASS

- [x] **Step 6: 提交**

```bash
git add apps/api
git commit -m "feat(api): 地点外链 admin CRUD,地点详情带 links——admin 地点路由独立成文件"
```

---

### Task 6: admin 外链管理页

**Files:**
- Modify: `apps/admin/app/places/page.tsx`(行内加"外链"入口)
- Create: `apps/admin/app/places/[id]/page.tsx`

**Interfaces:**
- Consumes: Task 5 的 `GET /places/:id`(links)、`POST /admin/places/:id/links`、`PATCH /admin/links/:id`、`DELETE /admin/links/:id`。

- [x] **Step 1: 地点列表行加入口**

`apps/admin/app/places/page.tsx` 整体替换为:

```tsx
"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

type Place = { id: string; name: string; level: string; parentId: string | null; lat: number; lng: number };

export default function PlacesPage() {
  const [places, setPlaces] = useState<Place[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    api<Place[]>("/places").then(setPlaces).catch((e) => setError(String(e)));
  }, []);
  return (
    <>
      <h2>地点库（{places.length}）</h2>
      {error && <p style={{ color: "red" }}>{error}</p>}
      <table>
        <thead><tr><th>名称</th><th>层级</th><th>坐标</th><th>操作</th></tr></thead>
        <tbody>
          {places.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td>{p.level}</td>
              <td>{p.lat.toFixed(3)}, {p.lng.toFixed(3)}</td>
              <td><Link href={`/places/${p.id}`}>外链</Link></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
```

- [x] **Step 2: 外链管理详情页**

新建 `apps/admin/app/places/[id]/page.tsx`:

```tsx
"use client";
import { use, useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

type PlaceLink = { id: string; platform: string; title: string; url: string; sortOrder: number };
type PlaceDetail = { id: string; name: string; level: string; ancestors: { name: string }[]; links: PlaceLink[] };

const PLATFORMS = ["XIAOHONGSHU", "BILIBILI", "DOUYIN", "WEIBO", "OTHER"] as const;
const PLATFORM_LABELS: Record<string, string> = {
  XIAOHONGSHU: "小红书", BILIBILI: "B 站", DOUYIN: "抖音", WEIBO: "微博", OTHER: "其他",
};

export default function PlaceLinksPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [place, setPlace] = useState<PlaceDetail | null>(null);
  const [error, setError] = useState("");
  const [platform, setPlatform] = useState<string>("XIAOHONGSHU");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [sortOrder, setSortOrder] = useState(0);

  const load = useCallback(() => {
    api<PlaceDetail>(`/places/${id}`).then(setPlace).catch((e) => setError(String(e)));
  }, [id]);
  useEffect(load, [load]);

  async function addLink() {
    try {
      await api(`/admin/places/${id}/links`, {
        method: "POST",
        body: JSON.stringify({ platform, title, url, sortOrder }),
      });
      setTitle(""); setUrl(""); setSortOrder(0);
      load();
    } catch (e) { setError(String(e)); }
  }

  async function removeLink(linkId: string) {
    try {
      await api(`/admin/links/${linkId}`, { method: "DELETE" });
      load();
    } catch (e) { setError(String(e)); }
  }

  async function saveOrder(linkId: string, next: number) {
    try {
      await api(`/admin/links/${linkId}`, { method: "PATCH", body: JSON.stringify({ sortOrder: next }) });
      load();
    } catch (e) { setError(String(e)); }
  }

  if (!place) return <p>{error || "加载中…"}</p>;
  return (
    <>
      <h2>
        {place.ancestors.map((a) => a.name).concat(place.name).join(" · ")}｜网友攻略外链（{place.links.length}）
      </h2>
      {error && <p style={{ color: "red" }}>{error}</p>}
      <table>
        <thead><tr><th>排序</th><th>平台</th><th>标题</th><th>链接</th><th>操作</th></tr></thead>
        <tbody>
          {place.links.map((l) => (
            <tr key={l.id}>
              <td>
                <input
                  type="number" defaultValue={l.sortOrder} style={{ width: 64 }}
                  onBlur={(e) => {
                    const next = Number(e.target.value);
                    if (next !== l.sortOrder) saveOrder(l.id, next);
                  }}
                />
              </td>
              <td>{PLATFORM_LABELS[l.platform] ?? l.platform}</td>
              <td>{l.title}</td>
              <td><a href={l.url} target="_blank" rel="noreferrer">{l.url}</a></td>
              <td><button onClick={() => removeLink(l.id)}>删除</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>新增外链</h3>
      <p>
        <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
          {PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABELS[p]}</option>)}
        </select>{" "}
        <input placeholder="标题" value={title} onChange={(e) => setTitle(e.target.value)} />{" "}
        <input placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} size={40} />{" "}
        <input type="number" value={sortOrder} onChange={(e) => setSortOrder(Number(e.target.value))} style={{ width: 64 }} />{" "}
        <button onClick={addLink} disabled={!title || !url.startsWith("https://")}>添加</button>
      </p>
    </>
  );
}
```

- [x] **Step 3: 浏览器验证**

启动 preview(launch.json 已配 api :8799 + admin :3000),在 admin 地点库点进任一地点:添加两条不同 sortOrder 的链接 → 列表按序显示;改排序、删除各验证一次;贴 `http://` 链接应报 400。

- [x] **Step 4: 提交**

```bash
git add apps/admin
git commit -m "feat(admin): 地点外链管理页——增删/调序"
```

---

### Task 7: iOS 攻略区块(地点抽屉)

**Files:**
- Modify: `apps/ios/Zhixing/Core/Models.swift`(PlaceLink + PlaceDetail.links + platformLabel)
- Create: `apps/ios/Zhixing/Place/PlaceLinksSection.swift`
- Modify: `apps/ios/Zhixing/Place/PlaceDrawer.swift`(风物卡 tab 底部挂区块)
- Test: `apps/ios/Tests/PlacePathTests.swift`(追加)

**Interfaces:**
- Produces: `PlaceLink { id, platform, title, url, platformLabel }`、`PlaceDetail.links: [PlaceLink]?`(可选,容错旧缓存/旧服务端)、`PlaceLinksSection(links:)` 视图。

- [x] **Step 1: 写失败测试**

`apps/ios/Tests/PlacePathTests.swift` 追加:

```swift
    func testPlaceDetailDecodesLinksAndPlatformLabel() throws {
        let json = """
        {"id":"p1","name":"什刹海","level":"DISTRICT","intro":null,"ancestors":[],
         "links":[{"id":"l1","platform":"XIAOHONGSHU","title":"citywalk 路线",
                   "url":"https://example.com/a","sortOrder":1}]}
        """
        let detail = try APIClient.decoder.decode(PlaceDetail.self, from: Data(json.utf8))
        XCTAssertEqual(detail.links?.first?.platformLabel, "小红书")
    }

    /// links 字段缺失(旧服务端/缓存)不应让整个详情解码失败。
    func testPlaceDetailToleratesMissingLinks() throws {
        let json = """
        {"id":"p1","name":"什刹海","level":"DISTRICT","intro":null,"ancestors":[]}
        """
        let detail = try APIClient.decoder.decode(PlaceDetail.self, from: Data(json.utf8))
        XCTAssertNil(detail.links)
    }
```

Run: `scripts/ios-test.sh` → Expected: FAIL(编译错误)。

- [x] **Step 2: 模型**

`Models.swift` 的 `PlaceDetail` 内 `let ancestors: [PlaceAncestor]` 之后追加:

```swift
    /// 旧服务端/缓存无此字段,可选容错;空数组与 nil 均不渲染攻略区。
    let links: [PlaceLink]?
```

`PlaceDetail` 之后追加:

```swift
struct PlaceLink: Codable, Identifiable {
    let id: String
    let platform: String
    let title: String
    let url: String

    static let platformLabels = [
        "XIAOHONGSHU": "小红书", "BILIBILI": "B 站", "DOUYIN": "抖音",
        "WEIBO": "微博", "OTHER": "网页",
    ]
    var platformLabel: String { Self.platformLabels[platform] ?? platform }
}
```

(Task 3 已写好的 `PlaceDetail` 测试 JSON 无 links 键,可选属性解码兼容,不需回改。)

- [x] **Step 3: 攻略区视图**

新建 `apps/ios/Zhixing/Place/PlaceLinksSection.swift`:

```swift
import SafariServices
import SwiftUI

/// 地点抽屉「网友攻略」区块:管理员维护的外部平台链接列表。
/// iOS 用 SFSafariViewController 应用内打开;Catalyst 交给系统默认浏览器。
struct PlaceLinksSection: View {
    let links: [PlaceLink]
    @State private var safariURL: URL?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("网友攻略", systemImage: "link")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(ZXTheme.pine)
            ForEach(links) { link in
                Button {
                    open(link)
                } label: {
                    HStack(spacing: 12) {
                        Text(link.platformLabel)
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 8).padding(.vertical, 3)
                            .foregroundStyle(.white)
                            .background(ZXTheme.cinnabar, in: Capsule())
                        Text(link.title)
                            .font(.subheadline)
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                        Spacer(minLength: 8)
                        Image(systemName: "arrow.up.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.tertiary)
                    }
                    .zxSurface(radius: 14, padding: 13)
                }
                .buttonStyle(.plain)
                .accessibilityHint("在浏览器中打开")
            }
        }
        #if !targetEnvironment(macCatalyst)
        .sheet(item: Binding(
            get: { safariURL.map(SafariItem.init) },
            set: { if $0 == nil { safariURL = nil } }
        )) { item in
            SafariView(url: item.url).ignoresSafeArea()
        }
        #endif
    }

    private func open(_ link: PlaceLink) {
        guard let url = URL(string: link.url), url.scheme == "https" else { return }
        #if targetEnvironment(macCatalyst)
        UIApplication.shared.open(url) // Catalyst → 系统默认浏览器
        #else
        safariURL = url
        #endif
    }
}

#if !targetEnvironment(macCatalyst)
private struct SafariItem: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}

private struct SafariView: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }
    func updateUIViewController(_ vc: SFSafariViewController, context: Context) {}
}
#endif
```

- [x] **Step 4: 挂进抽屉**

`PlaceDrawer.swift` 的 `cardsContent` 中,`ForEach(cards) { ... }` 闭合之后(仍在 `LazyVStack` 内)追加:

```swift
                if let links = placeDetail?.links, !links.isEmpty {
                    PlaceLinksSection(links: links)
                        .padding(.top, 6)
                }
```

- [x] **Step 5: xcodegen + 测试 + 走查**

```bash
cd apps/ios && xcodegen generate && cd ../..
scripts/ios-test.sh
scripts/mac-dev.sh
```

Expected: 测试 PASS;走查:给某地点后台加两条链接后,抽屉风物卡列表底部出现"网友攻略",点击在默认浏览器打开;无链接地点不出现该区块。

- [x] **Step 6: 提交**

```bash
git add apps/ios
git commit -m "feat(ios): 地点抽屉网友攻略区块——链接跳浏览器"
```

---

# 里程碑 B:用户申请新地点

### Task 8: schema——PlaceStatus + createdBy

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Test: `packages/db/test/schema.test.ts`

**Interfaces:**
- Produces: `enum PlaceStatus { ACTIVE PENDING REJECTED }`;`Place.status`(默认 ACTIVE,存量零迁移)、`Place.createdById?/createdBy?`(User, onDelete SetNull)、`User.createdPlaces`。

- [x] **Step 1: schema 变更**

`schema.prisma`:`LinkPlatform` 枚举之后追加:

```prisma
enum PlaceStatus {
  ACTIVE // 官方/审核通过,全网可见
  PENDING // 用户申请待审,仅本人可见
  REJECTED // 审核未通过,仅本人可见(其上足迹保留私有)
}
```

`Place` 模型改为(在 `links` 行之后、`createdAt` 之前插入三行,并加索引):

```prisma
model Place {
  id          String      @id @default(cuid())
  name        String
  level       PlaceLevel
  parentId    String?
  parent      Place?      @relation("PlaceTree", fields: [parentId], references: [id])
  children    Place[]     @relation("PlaceTree")
  lat         Float
  lng         Float
  intro       String?
  cards       Card[]
  footprints  Footprint[]
  links       PlaceLink[]
  status      PlaceStatus @default(ACTIVE)
  createdById String?
  createdBy   User?       @relation("UserCreatedPlaces", fields: [createdById], references: [id], onDelete: SetNull)
  createdAt   DateTime    @default(now())

  @@unique([name, parentId])
  @@index([level])
  @@index([status])
}
```

`User` 模型 `identities Identity[]` 之后追加:

```prisma
  createdPlaces Place[]  @relation("UserCreatedPlaces")
```

- [x] **Step 2: 迁移 + 测试库**

```bash
pnpm --filter @zhixing/db exec prisma migrate dev --name place-status
pnpm -C packages/db push:test
```

- [x] **Step 3: 模型测试**

`packages/db/test/schema.test.ts` 末尾追加:

```ts
test("Place.status 默认 ACTIVE;createdBy 用户删除后 SetNull", async () => {
  const official = await prisma.place.create({
    data: { name: "官方点", level: "DISTRICT", lat: 30, lng: 110 },
  });
  expect(official.status).toBe("ACTIVE");

  const user = await prisma.user.create({ data: { nickname: "旅人" } });
  const submitted = await prisma.place.create({
    data: { name: "用户点", level: "POI", lat: 30, lng: 110, status: "PENDING", createdById: user.id },
  });
  expect(submitted.status).toBe("PENDING");

  await prisma.user.delete({ where: { id: user.id } });
  const after = await prisma.place.findUniqueOrThrow({ where: { id: submitted.id } });
  expect(after.createdById).toBeNull(); // 点保留,归属清空
});
```

- [x] **Step 4: 跑测试 + 提交**

Run: `pnpm -C packages/db exec vitest run`
Expected: PASS

```bash
git add packages/db
git commit -m "feat(db): Place 状态机与提交者——PENDING/REJECTED 仅本人可见的地基"
```

---

### Task 9: 开关 + optionalUser + 可见性判据

**Files:**
- Modify: `apps/api/src/config.ts`、`apps/api/src/app.ts`、`apps/api/src/auth.ts`、`apps/api/src/visibility.ts`
- Modify: `apps/api/test/helpers.ts`(testApp 支持 overrides)
- Test: `apps/api/test/places.test.ts`(app-config 开关断言)

**Interfaces:**
- Produces: `config.placeSubmission`(env `ZHIXING_PLACE_SUBMISSION`,**默认开**,`"0"` 关);`app.placeSubmission: boolean`(buildApp opts 可注入,镜像 devAuth 模式);`GET /app-config` 追加 `placeSubmission`;`optionalUser` preHandler(设 `req.optionalUserId: string | null`,绝不 401);visibility.ts 的 `PLACE_ACTIVE` / `placeVisibleTo(userId)` / `placeSearchableTo(userId)`;`testApp(overrides?)`。
- Consumes: Task 8 的 status 字段。

- [x] **Step 1: 写失败测试**

`apps/api/test/places.test.ts` 末尾追加(依赖本任务稍后给 testApp 加的 overrides 参数——红阶段表现为编译失败,同样算红):

```ts
test("app-config 下发地点申请开关;buildApp 可注入关闭", async () => {
  const on = await app.inject({ method: "GET", url: "/app-config" });
  expect(on.json().placeSubmission).toBe(true); // 测试默认开

  const offApp = testApp({ placeSubmission: false });
  const off = await offApp.inject({ method: "GET", url: "/app-config" });
  expect(off.json().placeSubmission).toBe(false);
  await offApp.close();
});
```

(该文件顶部 import 需把 `testApp` 已含在内——现状已 import,无需改。)

Run: `pnpm -C apps/api exec vitest run test/places.test.ts` → FAIL(placeSubmission 不存在,类型/断言双红)。

- [x] **Step 2: 实现**

`apps/api/src/config.ts` 在 `trustProxy` 行之后追加:

```ts
  // 用户申请新地点的运营开关:前期数据不足默认开放,覆盖度够了置 "0" 关闭。
  // iOS 经 /app-config 读它决定入口显隐;POST /places 服务端硬校验兜底。
  placeSubmission: process.env.ZHIXING_PLACE_SUBMISSION !== "0",
```

`apps/api/src/app.ts`:
1. `declare module "fastify"` 的 FastifyInstance 增加 `placeSubmission: boolean;`
2. `BuildAppOpts` 增加 `placeSubmission?: boolean;`
3. `app.decorate("devAuth", ...)` 之后加:

```ts
  app.decorate("placeSubmission", opts.placeSubmission ?? config.placeSubmission);
```

4. `/app-config` 路由改为:

```ts
    app.get("/app-config", async () => ({
      shareLandingUrl: config.shareLandingUrl,
      placeSubmission: app.placeSubmission,
    }));
```

`apps/api/src/auth.ts`:模块尾追加:

```ts
declare module "fastify" {
  interface FastifyRequest {
    /** optionalUser 解析结果:未带/非法 Bearer 时为 null,绝不 401 */
    optionalUserId: string | null;
  }
}

/**
 * 可选登录:匿名照常放行,带合法 Bearer 则识别身份。
 * 用于"匿名可读、登录后额外可见自己私有数据"的读面(pins/搜索/地点详情)。
 */
export async function optionalUser(req: FastifyRequest) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    req.optionalUserId = null;
    return;
  }
  try {
    req.optionalUserId = await verifySession(header.slice(7));
  } catch {
    req.optionalUserId = null;
  }
}
```

`apps/api/src/visibility.ts` 追加:

```ts
/** 地点公开判据:仅 ACTIVE 对所有人可见。公开面(public.ts 等)一律引用它。 */
export const PLACE_ACTIVE = { status: "ACTIVE" } as const;

/** 用户面地点可见判据:ACTIVE,或本人创建(含待审 PENDING 与驳回 REJECTED——驳回点
 *  仍要在地图上可见,否则其上足迹成孤儿)。匿名等同"只见 ACTIVE"。 */
export function placeVisibleTo(userId: string | null) {
  return userId
    ? { OR: [{ status: "ACTIVE" as const }, { createdById: userId }] }
    : PLACE_ACTIVE;
}

/** 搜索/选点判据:比可见收窄——REJECTED 不进搜索结果,避免引导用户往驳回点上继续挂足迹。 */
export function placeSearchableTo(userId: string | null) {
  return userId
    ? { OR: [{ status: "ACTIVE" as const }, { status: "PENDING" as const, createdById: userId }] }
    : PLACE_ACTIVE;
}
```

`apps/api/test/helpers.ts`:import 行改为 `import { buildApp, type BuildAppOpts } from "../src/app.js";`,`testApp` 改为支持覆盖(供关开关/调参测试):

```ts
export function testApp(overrides: Partial<BuildAppOpts> = {}) {
  return buildApp({
    databaseUrl: TEST_DB_URL,
    appleJwks,
    devAuth: true,
    s3Bucket: TEST_S3_BUCKET,
    rateLimit: false,
    ...overrides,
  });
}
```

- [x] **Step 3: 跑全量 + 提交**

Run: `pnpm -C apps/api exec vitest run`
Expected: PASS

```bash
git add apps/api
git commit -m "feat(api): 地点申请开关经 app-config 下发 + optionalUser 与地点可见性判据"
```

---

### Task 10: POST /places——用户申请新地点

**Files:**
- Create: `apps/api/src/geo.ts`
- Modify: `apps/api/src/routes/places.ts`
- Test: `apps/api/test/placeSubmission.test.ts`(新建)

**Interfaces:**
- Produces: `POST /places`(requireUser)body `{ name: string(1-50), lat: number(-90..90), lng: number(-180..180) }` → 201 Pin 形状 `{ id, name, level: "POI", parentId, lat, lng, status: "PENDING", cardCount: 0 }`。错误:403 `place_submission_disabled` / 429 `daily_limit` / 409 `place_exists`(附 `placeId`)/ 400 `invalid_body`。`haversineMeters(lat1,lng1,lat2,lng2)`(geo.ts)。运营常量 `PLACE_SUBMISSION = { dailyLimit: 10, parentRadiusMeters: 150_000 }`。
- Consumes: Task 9 的 `app.placeSubmission`、Task 8 的 status/createdById。

- [x] **Step 1: 写失败测试**

新建 `apps/api/test/placeSubmission.test.ts`:

```ts
import { afterAll, beforeEach, expect, test } from "vitest";
import { resetDb, testApp, userAuth } from "./helpers.js";

const app = testApp();
beforeEach(() => resetDb(app));
afterAll(async () => app.close());

test("提交新地点:PENDING/POI/归属本人,父级自动挂最近城市", async () => {
  const prov = await app.prisma.place.create({
    data: { name: "山东省", level: "PROVINCE", lat: 36.67, lng: 117.02 },
  });
  const jinan = await app.prisma.place.create({
    data: { name: "济南市", level: "CITY", parentId: prov.id, lat: 36.651, lng: 117.12 },
  });
  const { headers, user } = await userAuth(app);

  const res = await app.inject({
    method: "POST", url: "/places", headers,
    payload: { name: "宽厚里", lat: 36.661, lng: 117.03 },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  expect(body.status).toBe("PENDING");
  expect(body.level).toBe("POI");
  expect(body.parentId).toBe(jinan.id); // 12km 内命中济南
  expect(body.cardCount).toBe(0);
  expect(body).not.toHaveProperty("createdById"); // 归属不外传

  const row = await app.prisma.place.findUniqueOrThrow({ where: { id: body.id } });
  expect(row.createdById).toBe(user.id);
});

test("直辖市可作父级(省级链顶且无市级子节点);远海无候选则父级为空", async () => {
  const beijing = await app.prisma.place.create({
    data: { name: "北京市", level: "PROVINCE", lat: 39.9042, lng: 116.4074 },
  });
  await app.prisma.place.create({
    data: { name: "什刹海", level: "DISTRICT", parentId: beijing.id, lat: 39.94, lng: 116.38 },
  });
  const { headers } = await userAuth(app);

  const near = await app.inject({
    method: "POST", url: "/places", headers,
    payload: { name: "杨梅竹斜街", lat: 39.895, lng: 116.392 },
  });
  expect(near.json().parentId).toBe(beijing.id);

  const far = await app.inject({
    method: "POST", url: "/places", headers,
    payload: { name: "南海孤岛", lat: 10.0, lng: 114.0 },
  });
  expect(far.statusCode).toBe(201);
  expect(far.json().parentId).toBeNull();
});

test("普通省(有市级子节点)不做父级候选:落点挂市不挂省", async () => {
  const prov = await app.prisma.place.create({
    data: { name: "山东省", level: "PROVINCE", lat: 36.6683, lng: 117.0201 },
  });
  const jinan = await app.prisma.place.create({
    data: { name: "济南市", level: "CITY", parentId: prov.id, lat: 36.651, lng: 117.12 },
  });
  const { headers } = await userAuth(app);
  const res = await app.inject({
    method: "POST", url: "/places", headers,
    payload: { name: "曲水亭街", lat: 36.668, lng: 117.024 }, // 离省坐标(=济南)与市坐标都近
  });
  expect(res.json().parentId).toBe(jinan.id);
});

test("同名同父冲突 409 并回已有地点 id", async () => {
  const city = await app.prisma.place.create({
    data: { name: "济南市", level: "CITY", lat: 36.651, lng: 117.12 },
  });
  const exist = await app.prisma.place.create({
    data: { name: "芙蓉街", level: "DISTRICT", parentId: city.id, lat: 36.665, lng: 117.023 },
  });
  const { headers } = await userAuth(app);
  const res = await app.inject({
    method: "POST", url: "/places", headers,
    payload: { name: "芙蓉街", lat: 36.665, lng: 117.023 },
  });
  expect(res.statusCode).toBe(409);
  expect(res.json()).toEqual({ error: "place_exists", placeId: exist.id });
});

test("24 小时滚动窗内第 11 个申请 429;开关关闭 403;匿名 401;非法 body 400", async () => {
  const { headers } = await userAuth(app);
  for (let i = 0; i < 10; i++) {
    const res = await app.inject({
      method: "POST", url: "/places", headers,
      payload: { name: `新点${i}`, lat: 30 + i * 0.01, lng: 110 },
    });
    expect(res.statusCode).toBe(201);
  }
  const eleventh = await app.inject({
    method: "POST", url: "/places", headers,
    payload: { name: "第十一个", lat: 31, lng: 110 },
  });
  expect(eleventh.statusCode).toBe(429);
  expect(eleventh.json().error).toBe("daily_limit");

  const offApp = testApp({ placeSubmission: false });
  const { headers: offHeaders } = await userAuth(offApp);
  const off = await offApp.inject({
    method: "POST", url: "/places", headers: offHeaders,
    payload: { name: "关着呢", lat: 30, lng: 110 },
  });
  expect(off.statusCode).toBe(403);
  expect(off.json().error).toBe("place_submission_disabled");
  await offApp.close();

  const anon = await app.inject({
    method: "POST", url: "/places", payload: { name: "匿名", lat: 30, lng: 110 },
  });
  expect(anon.statusCode).toBe(401);

  const bad = await app.inject({
    method: "POST", url: "/places", headers,
    payload: { name: "", lat: 999, lng: 110 },
  });
  expect(bad.statusCode).toBe(400);
  expect(bad.json().error).toBe("invalid_body");
});
```

Run: `pnpm -C apps/api exec vitest run test/placeSubmission.test.ts` → FAIL(POST /places 404)。

- [x] **Step 2: 实现**

新建 `apps/api/src/geo.ts`:

```ts
/** 球面两点距离(米)——与 iOS GeoMatch.swift 的 haversineMeters 同式,服务端父级自动猜用。 */
export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const r = 6_371_000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * r * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
```

`apps/api/src/routes/places.ts`:头部 import 增加

```ts
import { requireUser } from "../auth.js";
import { haversineMeters } from "../geo.js";
```

常量区(`levelEnum` 附近)追加:

```ts
/** 用户申请新地点的运营参数,集中一处便于调整:
 *  dailyLimit——每用户 24 小时滚动窗建点上限;parentRadiusMeters——父级自动猜半径。 */
const PLACE_SUBMISSION = { dailyLimit: 10, parentRadiusMeters: 150_000 } as const;

const submitPlaceSchema = z.object({
  name: z.string().trim().min(1).max(50),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
```

`placesRoutes` 内追加路由:

```ts
  app.post("/places", { preHandler: requireUser }, async (req, reply) => {
    // 开关硬校验:客户端藏按钮只是体验,授权在服务端
    if (!app.placeSubmission) {
      return reply.code(403).send({ error: "place_submission_disabled" });
    }
    const body = submitPlaceSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    }

    // 防滥用:24 小时滚动窗上限(不按自然日,免时区口径之争)
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recent = await app.prisma.place.count({
      where: { createdById: req.userId, createdAt: { gte: dayAgo } },
    });
    if (recent >= PLACE_SUBMISSION.dailyLimit) {
      return reply.code(429).send({ error: "daily_limit" });
    }

    // 父级自动猜:最近的"城市级"节点。候选 = CITY,加上"无市级子节点的 PROVINCE"
    // (直辖市/特区:北京下面直接是街区)。真正的省(山东省,有 CITY 子节点)不收编落点。
    const candidates = await app.prisma.place.findMany({
      where: {
        status: "ACTIVE",
        OR: [
          { level: "CITY" },
          { level: "PROVINCE", children: { none: { level: "CITY" } } },
        ],
      },
      select: { id: true, lat: true, lng: true },
    });
    let parentId: string | null = null;
    let best = PLACE_SUBMISSION.parentRadiusMeters;
    for (const c of candidates) {
      const d = haversineMeters(body.data.lat, body.data.lng, c.lat, c.lng);
      if (d <= best) {
        best = d;
        parentId = c.id;
      }
    }

    // 同名同父即重复:回 409 引导直接选用已有地点(这本身就是防重复录入)
    const dup = await app.prisma.place.findFirst({
      where: { name: body.data.name, parentId },
      select: { id: true },
    });
    if (dup) return reply.code(409).send({ error: "place_exists", placeId: dup.id });

    try {
      const place = await app.prisma.place.create({
        data: {
          name: body.data.name,
          level: "POI",
          parentId,
          lat: body.data.lat,
          lng: body.data.lng,
          status: "PENDING",
          createdById: req.userId,
        },
      });
      // Pin 形状 DTO:iOS 直接当 Pin 用;createdById 不外传
      return reply.code(201).send({
        id: place.id, name: place.name, level: place.level, parentId: place.parentId,
        lat: place.lat, lng: place.lng, status: place.status, cardCount: 0,
      });
    } catch (e) {
      // 并发撞唯一键(name,parentId):按已存在处理
      if (e && typeof e === "object" && "code" in e && e.code === "P2002") {
        const race = await app.prisma.place.findFirst({
          where: { name: body.data.name, parentId },
          select: { id: true },
        });
        return reply.code(409).send({ error: "place_exists", placeId: race?.id ?? null });
      }
      throw e;
    }
  });
```

- [x] **Step 3: 跑全量 + 提交**

Run: `pnpm -C apps/api exec vitest run`
Expected: PASS

```bash
git add apps/api
git commit -m "feat(api): 用户申请新地点——PENDING 建点/父级自动猜/每日上限/重名引导"
```

---

### Task 11: 读面可见性收口——pins / random / 搜索 / 详情 / 列表 / 公开面 / 补卡

**Files:**
- Modify: `apps/api/src/routes/places.ts`、`apps/api/src/routes/search.ts`、`apps/api/src/routes/public.ts`
- Modify: `apps/pipeline/src/batch.ts`
- Test: `apps/api/test/placeVisibility.test.ts`(新建)、`apps/api/test/places.test.ts`(/places 加 admin 头)、`apps/pipeline/test/batch.test.ts`(追加)

**Interfaces:**
- Produces: `GET /places/pins` 加 `optionalUser`——返回 ACTIVE + 本人 PENDING/REJECTED,DTO 增 `status` 字段;`GET /places/random` 只随机 ACTIVE;`GET /search` 加 `optionalUser`——ACTIVE + 本人 PENDING;`GET /places/:id` 加 `optionalUser`——非本人的 PENDING/REJECTED 404,DTO 增 `status`;`GET /places` 改 **requireAdmin**(唯一消费方是 admin console;user 建点后含 createdById 的整行不能再裸奔在匿名接口上);`/places/:id/stories` 与 `/places/:id/photo-wall` 的地点查找按 `placeVisibleTo(req.userId)` 过滤(他人待审点 404,杜绝地点枚举);pipeline `queryFillTargets(prisma, city?)`——batch 补卡只圈 ACTIVE 地点。
- Consumes: Task 9 的 optionalUser/placeVisibleTo/placeSearchableTo。

- [x] **Step 1: 写失败测试**

新建 `apps/api/test/placeVisibility.test.ts`:

```ts
import { afterAll, beforeEach, expect, test } from "vitest";
import { resetDb, testApp, userAuth } from "./helpers.js";

const app = testApp();
beforeEach(() => resetDb(app));
afterAll(async () => app.close());

async function submitPlace(headers: Record<string, string>, name: string, lat = 30, lng = 110) {
  const res = await app.inject({ method: "POST", url: "/places", headers, payload: { name, lat, lng } });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}

test("pins:本人见自己的 PENDING/REJECTED,他人与匿名不见;DTO 带 status", async () => {
  await app.prisma.place.create({ data: { name: "官方点", level: "DISTRICT", lat: 31, lng: 111 } });
  const alice = await userAuth(app, "alice");
  const bob = await userAuth(app, "bob");
  const pending = await submitPlace(alice.headers, "洪家楼");
  const rejected = await submitPlace(alice.headers, "老商埠");
  await app.prisma.place.update({ where: { id: rejected.id }, data: { status: "REJECTED" } });

  const mine = (await app.inject({ method: "GET", url: "/places/pins", headers: alice.headers })).json() as Array<{ id: string; status: string }>;
  expect(mine.map((p) => p.id)).toContain(pending.id);
  expect(mine.map((p) => p.id)).toContain(rejected.id);
  expect(mine.find((p) => p.id === pending.id)?.status).toBe("PENDING");

  const others = (await app.inject({ method: "GET", url: "/places/pins", headers: bob.headers })).json() as Array<{ id: string }>;
  expect(others.map((p) => p.id)).not.toContain(pending.id);

  const anon = (await app.inject({ method: "GET", url: "/places/pins" })).json() as Array<{ id: string }>;
  expect(anon.map((p) => p.id)).not.toContain(pending.id);
  expect(anon).toHaveLength(1); // 只有官方点
});

test("搜索:本人可搜到自己的 PENDING;REJECTED 不进搜索;他人不见", async () => {
  const alice = await userAuth(app, "alice");
  const bob = await userAuth(app, "bob");
  const pending = await submitPlace(alice.headers, "洪家楼");
  const rejected = await submitPlace(alice.headers, "老商埠");
  await app.prisma.place.update({ where: { id: rejected.id }, data: { status: "REJECTED" } });

  const mine = (await app.inject({ method: "GET", url: "/search?q=洪家楼", headers: alice.headers })).json() as Array<{ id: string }>;
  expect(mine.map((p) => p.id)).toContain(pending.id);

  const mineRejected = (await app.inject({ method: "GET", url: "/search?q=老商埠", headers: alice.headers })).json() as Array<{ id: string }>;
  expect(mineRejected).toHaveLength(0);

  const others = (await app.inject({ method: "GET", url: "/search?q=洪家楼", headers: bob.headers })).json() as Array<{ id: string }>;
  expect(others).toHaveLength(0);
});

test("详情:非本人的 PENDING 404,本人 200 且带 status", async () => {
  const alice = await userAuth(app, "alice");
  const bob = await userAuth(app, "bob");
  const pending = await submitPlace(alice.headers, "洪家楼");

  const mine = await app.inject({ method: "GET", url: `/places/${pending.id}`, headers: alice.headers });
  expect(mine.statusCode).toBe(200);
  expect(mine.json().status).toBe("PENDING");

  expect((await app.inject({ method: "GET", url: `/places/${pending.id}`, headers: bob.headers })).statusCode).toBe(404);
  expect((await app.inject({ method: "GET", url: `/places/${pending.id}` })).statusCode).toBe(404);
});

test("random 绝不落在非 ACTIVE 地点(即使它有卡)", async () => {
  const alice = await userAuth(app, "alice");
  const pending = await submitPlace(alice.headers, "洪家楼");
  await app.prisma.card.create({
    data: {
      placeId: pending.id, category: "ANECDOTE", title: "x", sources: [],
      blocks: { create: [{ order: 0, type: "TEXT", text: "a".repeat(60) }] },
    },
  });
  const res = await app.inject({ method: "GET", url: "/places/random", headers: alice.headers });
  expect(res.statusCode).toBe(404); // 唯一有卡的点是 PENDING → 无可随机
});

test("GET /places 列表收归 admin", async () => {
  expect((await app.inject({ method: "GET", url: "/places" })).statusCode).toBe(401);
});

test("公开面:他人的 PENDING 地点 stories/photo-wall 404,本人可见(空列表)", async () => {
  const alice = await userAuth(app, "alice");
  const bob = await userAuth(app, "bob");
  const pending = await submitPlace(alice.headers, "洪家楼");

  const mine = await app.inject({
    method: "GET", url: `/places/${pending.id}/stories`, headers: alice.headers,
  });
  expect(mine.statusCode).toBe(200);
  expect(mine.json().items).toEqual([]);

  expect((await app.inject({
    method: "GET", url: `/places/${pending.id}/stories`, headers: bob.headers,
  })).statusCode).toBe(404);
  expect((await app.inject({
    method: "GET", url: `/places/${pending.id}/photo-wall`, headers: bob.headers,
  })).statusCode).toBe(404);
});
```

`apps/pipeline/test/batch.test.ts` 末尾追加(该文件现为 `pickJobs` 纯函数测试,补一段真库测试,prisma 样板对齐 import.test.ts):

```ts
import { createPrisma } from "@zhixing/db";
import { queryFillTargets } from "../src/batch.js";

const prisma = createPrisma(
  process.env.TEST_DATABASE_URL ?? "postgresql://zhixing:zhixing@localhost:5433/zhixing_test",
);

test("queryFillTargets 只圈 ACTIVE 地点——待审/驳回点不进补卡计划", async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "FootprintPhoto","Footprint","CardBlock","Card","PlaceLink","Place","User","SearchMiss" RESTART IDENTITY CASCADE',
  );
  await prisma.place.create({ data: { name: "官方点", level: "DISTRICT", lat: 30, lng: 110 } });
  await prisma.place.create({
    data: { name: "待审点", level: "POI", lat: 30, lng: 110, status: "PENDING" },
  });
  const targets = await queryFillTargets(prisma);
  expect(targets.map((t) => t.name)).toEqual(["官方点"]);
  await prisma.$disconnect();
});
```

(import 语句放文件顶部与既有 import 合并;若该文件没有 afterAll 断连,如上在用例内断连即可。)

同时修两处既有测试:

`apps/api/test/places.test.ts` 用例"创建并查询地点树"中:

```ts
  const list = await app.inject({ method: "GET", url: `/places?parentId=${cityId}` });
```

改为:

```ts
  const list = await app.inject({ method: "GET", url: `/places?parentId=${cityId}`, headers: ADMIN_AUTH });
```

detail 逐字段断言(Task 5 版本)改为含 status:

```ts
  expect(Object.keys(res.json()).sort()).toEqual(
    ["ancestors", "id", "intro", "lat", "level", "links", "lng", "name", "status"].sort(),
  );
```

Run: `pnpm -C apps/api exec vitest run test/placeVisibility.test.ts` → FAIL。

- [x] **Step 2: 实现**

`apps/api/src/routes/places.ts`:

import 增加:

```ts
import { optionalUser, requireAdmin, requireUser } from "../auth.js";
import { placeVisibleTo } from "../visibility.js";
```

`queryPins` 改签名带用户,过滤+带 status:

```ts
async function queryPins(app: FastifyInstance, userId: string | null) {
  const places = await app.prisma.place.findMany({
    where: placeVisibleTo(userId),
    select: { id: true, name: true, level: true, parentId: true, lat: true, lng: true, status: true },
    orderBy: { createdAt: "asc" },
  });
  const countBy = await countCardsByPlace(app.prisma, places.map((p) => p.id));
  return places.map((p) => ({ ...p, cardCount: countBy.get(p.id) ?? 0 }));
}
```

pins/random 路由改为:

```ts
  app.get(
    "/places/pins",
    { config: ipKeyedRateLimit, preHandler: optionalUser },
    async (req) => queryPins(app, req.optionalUserId),
  );

  app.get("/places/random", { config: ipKeyedRateLimit }, async (_req, reply) => {
    // 随机漫步是公开发现功能:只在 ACTIVE 且有内容的地点里抽,与登录态无关
    const withContent = (await queryPins(app, null)).filter((p) => p.cardCount > 0);
    if (withContent.length === 0) return reply.code(404).send({ error: "no_content" });
    const pick = withContent[Math.floor(Math.random() * withContent.length)];
    return { ...pick, ancestors: await placeAncestors(app.prisma, pick.parentId) };
  });
```

`GET /places` 加 requireAdmin:

```ts
  app.get("/places", { preHandler: requireAdmin }, async (req, reply) => {
```

`GET /places/:id` 改可见性 + status:

```ts
  app.get("/places/:id", { preHandler: optionalUser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const place = await app.prisma.place.findFirst({
      where: { id, AND: [placeVisibleTo(req.optionalUserId)] },
      include: { links: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] } },
    });
    if (!place) return reply.code(404).send({ error: "not_found" });
    return {
      id: place.id,
      name: place.name,
      level: place.level,
      lat: place.lat,
      lng: place.lng,
      intro: place.intro,
      status: place.status,
      ancestors: await placeAncestors(app.prisma, place.parentId),
      links: place.links.map((l) => ({
        id: l.id, platform: l.platform, title: l.title, url: l.url, sortOrder: l.sortOrder,
      })),
    };
  });
```

`apps/api/src/routes/search.ts`:import 增加

```ts
import { optionalUser } from "../auth.js";
import { placeSearchableTo } from "../visibility.js";
```

`/search` 路由选项加 `preHandler: optionalUser`,查询条件改:

```ts
      const places = await app.prisma.place.findMany({
        where: {
          name: { contains: query, mode: "insensitive" },
          AND: [placeSearchableTo(req.optionalUserId)],
        },
        select: { id: true, name: true, level: true, parentId: true, lat: true, lng: true, status: true },
        take: 20,
      });
```

(路由 options 形如 `{ config: searchRateLimit, preHandler: optionalUser }`。)

`apps/api/src/routes/public.ts`:import 区补 `import { placeVisibleTo } from "../visibility.js";`(与既有 PUBLICLY_VISIBLE 同行合并),`/places/:id/stories` 与 `/places/:id/photo-wall` 两处的地点查找

```ts
    const place = await app.prisma.place.findUnique({ where: { id } });
```

均改为(这两个端点都是 requireUser,`req.userId` 必有):

```ts
    const place = await app.prisma.place.findFirst({
      where: { id, AND: [placeVisibleTo(req.userId)] },
    });
```

`apps/pipeline/src/batch.ts`:import 行改为 `import { createPrisma, type PrismaClient } from "@zhixing/db";`,在 `pickJobs` 之后新增导出:

```ts
/** batch 补卡的目标地点:只圈 ACTIVE——待审/驳回的用户申请点不消耗生成额度。 */
export async function queryFillTargets(
  prisma: PrismaClient,
  city?: string,
): Promise<Array<{ id: string; name: string }>> {
  return prisma.place.findMany({
    where: {
      status: "ACTIVE",
      ...(city ? { OR: [{ parent: { name: city } }, { name: city }] } : {}),
    },
    select: { id: true, name: true },
  });
}
```

`main()` 里原来的

```ts
    const where = values.city
      ? { OR: [{ parent: { name: values.city } }, { name: values.city }] }
      : {};
    const places = await prisma.place.findMany({ where, select: { id: true, name: true } });
```

替换为:

```ts
    const places = await queryFillTargets(prisma, values.city);
```

- [x] **Step 3: 跑全量 + 提交**

Run: `pnpm -C apps/api exec vitest run && pnpm -C apps/pipeline exec vitest run`
Expected: PASS(注意 pins.test.ts 既有用例不带头也应照常通过——匿名见官方点)

```bash
git add apps/api apps/pipeline
git commit -m "feat(api,pipeline): 地点读面按状态收口——本人见待审,公开面与补卡只认 ACTIVE"
```

---

### Task 12: 足迹公开拦截——挂待审地点的足迹不能申请公开

**Files:**
- Modify: `apps/api/src/routes/footprints.ts`
- Test: `apps/api/test/footprints.test.ts`(追加)

**Interfaces:**
- Produces: `POST /footprints`(visibility=PUBLIC 时)与 `PATCH /footprints/:id`(切 PUBLIC 时)在地点非 ACTIVE 时返回 400 `{ error: "place_pending" }`;`FOOTPRINT_SELECT.place` 增加 `status`(iOS 编辑器靠它禁用公开开关)。
- Consumes: Task 8 的 Place.status。

- [x] **Step 1: 写失败测试**

`apps/api/test/footprints.test.ts` 末尾追加(该文件已有 `app`/`userAuth` 等基建,沿用其惯例):

```ts
test("挂 PENDING 地点的足迹:创建时直接公开与事后切公开都 400 place_pending;私密不受限", async () => {
  const { headers } = await userAuth(app, "submitter");
  const created = await app.inject({
    method: "POST", url: "/places", headers,
    payload: { name: "洪家楼", lat: 36.68, lng: 117.06 },
  });
  const placeId = created.json().id as string;

  const publicTry = await app.inject({
    method: "POST", url: "/footprints", headers,
    payload: { placeId, date: "2026-07-01T10:00:00.000+08:00", visibility: "PUBLIC" },
  });
  expect(publicTry.statusCode).toBe(400);
  expect(publicTry.json().error).toBe("place_pending");

  const privateOk = await app.inject({
    method: "POST", url: "/footprints", headers,
    payload: { placeId, date: "2026-07-01T10:00:00.000+08:00" },
  });
  expect(privateOk.statusCode).toBe(201);
  expect(privateOk.json().place.status).toBe("PENDING"); // 编辑器判据字段

  const fpId = privateOk.json().id as string;
  const patchTry = await app.inject({
    method: "PATCH", url: `/footprints/${fpId}`, headers,
    payload: { visibility: "PUBLIC" },
  });
  expect(patchTry.statusCode).toBe(400);
  expect(patchTry.json().error).toBe("place_pending");

  // 地点转正后放行
  await app.prisma.place.update({ where: { id: placeId }, data: { status: "ACTIVE" } });
  const patchOk = await app.inject({
    method: "PATCH", url: `/footprints/${fpId}`, headers,
    payload: { visibility: "PUBLIC" },
  });
  expect(patchOk.statusCode).toBe(200);
  expect(patchOk.json().reviewStatus).toBe("PENDING"); // 正常进足迹审核队列
});
```

Run: `pnpm -C apps/api exec vitest run test/footprints.test.ts` → FAIL。

- [x] **Step 2: 实现**

`apps/api/src/routes/footprints.ts`:

`FOOTPRINT_SELECT` 的 place 行改为:

```ts
  place: { select: { id: true, name: true, status: true } },
```

`POST /footprints` 中 `const isPublic = ...` 之后插入:

```ts
    // 待审/驳回地点上的足迹不能申请公开——公开面"非 ACTIVE 地点永不可见"的规则由此保持绝对
    if (isPublic && place.status !== "ACTIVE") {
      return reply.code(400).send({ error: "place_pending" });
    }
```

`PATCH /footprints/:id` 中 `if (visibility === "PUBLIC") {` 分支开头插入:

```ts
      const place = await app.prisma.place.findUnique({
        where: { id: existing.placeId },
        select: { status: true },
      });
      if (place?.status !== "ACTIVE") {
        return reply.code(400).send({ error: "place_pending" });
      }
```

(注意该分支要能 return,把原 `if/else if` 链保持原状,仅在 PUBLIC 分支首部加卫语句。)

- [x] **Step 3: 跑全量 + 提交**

Run: `pnpm -C apps/api exec vitest run`
Expected: PASS(既有足迹用例的 place DTO 多了 status 字段——`FOOTPRINT_SELECT` 是白名单 select,加字段不会破坏既有断言;若有 keys 全等断言按新形状更新)

```bash
git add apps/api
git commit -m "feat(api): 挂待审地点的足迹禁止申请公开——place_pending 拦截"
```

---

### Task 13: admin 审核 API——队列 / 通过 / 合并 / 拒绝

**Files:**
- Modify: `apps/api/src/routes/adminPlaces.ts`
- Test: `apps/api/test/adminPlaces.test.ts`(新建)

**Interfaces:**
- Produces:
  - `GET /admin/places/pending` → `{ total, items: [{ id, name, lat, lng, createdAt, parentId, parentName, creatorNickname }] }`(publicRequested 类比:按 createdAt asc)。
  - `POST /admin/places/:id/decision` body `{ action: "approve", name?, parentId? } | { action: "reject" }` → 204;非 PENDING 409 `not_pending`;approve 的 parentId 不存在 400 `unknown_parent`。
  - `POST /admin/places/:id/merge` body `{ targetId }` → 204;事务内迁移 footprints/cards/links/子节点后删除源点;源非 PENDING 409 `not_pending`,目标不存在或非 ACTIVE 400 `invalid_target`,源=目标 400 `invalid_target`。
- Consumes: Task 8 字段;Task 10 的提交流程造数。

- [x] **Step 1: 写失败测试**

新建 `apps/api/test/adminPlaces.test.ts`:

```ts
import { afterAll, beforeEach, expect, test } from "vitest";
import { ADMIN_AUTH, resetDb, testApp, userAuth } from "./helpers.js";

const app = testApp();
beforeEach(() => resetDb(app));
afterAll(async () => app.close());

async function submit(name: string, lat = 36.66, lng = 117.03) {
  const { headers, user } = await userAuth(app, "submitter");
  const res = await app.inject({ method: "POST", url: "/places", headers, payload: { name, lat, lng } });
  expect(res.statusCode).toBe(201);
  return { placeId: res.json().id as string, headers, userId: user.id as string };
}

test("pending 队列:带申请人昵称与猜中的父级名;需要 admin", async () => {
  const city = await app.prisma.place.create({
    data: { name: "济南市", level: "CITY", lat: 36.651, lng: 117.12 },
  });
  const { placeId } = await submit("洪家楼");

  expect((await app.inject({ method: "GET", url: "/admin/places/pending" })).statusCode).toBe(401);

  const res = await app.inject({ method: "GET", url: "/admin/places/pending", headers: ADMIN_AUTH });
  expect(res.statusCode).toBe(200);
  expect(res.json().total).toBe(1);
  const item = res.json().items[0];
  expect(item.id).toBe(placeId);
  expect(item.parentId).toBe(city.id);
  expect(item.parentName).toBe("济南市");
  expect(typeof item.creatorNickname).toBe("string");
});

test("approve:可顺手改名/改父级 → ACTIVE;重复裁决 409", async () => {
  const prov = await app.prisma.place.create({
    data: { name: "山东省", level: "PROVINCE", lat: 36.67, lng: 117.02 },
  });
  const city = await app.prisma.place.create({
    data: { name: "济南市", level: "CITY", parentId: prov.id, lat: 36.651, lng: 117.12 },
  });
  const { placeId } = await submit("洪楼", 36.68, 117.06);

  const ok = await app.inject({
    method: "POST", url: `/admin/places/${placeId}/decision`, headers: ADMIN_AUTH,
    payload: { action: "approve", name: "洪家楼广场", parentId: city.id },
  });
  expect(ok.statusCode).toBe(204);

  const row = await app.prisma.place.findUniqueOrThrow({ where: { id: placeId } });
  expect(row.status).toBe("ACTIVE");
  expect(row.name).toBe("洪家楼广场");
  expect(row.parentId).toBe(city.id);

  const again = await app.inject({
    method: "POST", url: `/admin/places/${placeId}/decision`, headers: ADMIN_AUTH,
    payload: { action: "reject" },
  });
  expect(again.statusCode).toBe(409);

  const badParent = await submit("另一个点", 30, 110);
  const bad = await app.inject({
    method: "POST", url: `/admin/places/${badParent.placeId}/decision`, headers: ADMIN_AUTH,
    payload: { action: "approve", parentId: "nope" },
  });
  expect(bad.statusCode).toBe(400);
  expect(bad.json().error).toBe("unknown_parent");
});

test("reject:REJECTED 后其上私密足迹保留", async () => {
  const { placeId, headers } = await submit("老商埠");
  await app.inject({
    method: "POST", url: "/footprints", headers,
    payload: { placeId, date: "2026-07-01T10:00:00.000+08:00" },
  });
  const res = await app.inject({
    method: "POST", url: `/admin/places/${placeId}/decision`, headers: ADMIN_AUTH,
    payload: { action: "reject" },
  });
  expect(res.statusCode).toBe(204);
  expect((await app.prisma.place.findUniqueOrThrow({ where: { id: placeId } })).status).toBe("REJECTED");
  expect(await app.prisma.footprint.count({ where: { placeId } })).toBe(1);
});

test("merge:足迹整体迁移到目标点,源点删除,统计随之归正", async () => {
  const city = await app.prisma.place.create({
    data: { name: "济南市", level: "CITY", lat: 36.651, lng: 117.12 },
  });
  const target = await app.prisma.place.create({
    data: { name: "芙蓉街", level: "DISTRICT", parentId: city.id, lat: 36.665, lng: 117.023 },
  });
  const { placeId, headers } = await submit("芙蓉街小吃街", 36.665, 117.024);
  await app.inject({
    method: "POST", url: "/footprints", headers,
    payload: { placeId, date: "2026-07-01T10:00:00.000+08:00" },
  });

  const wrongTarget = await app.inject({
    method: "POST", url: `/admin/places/${placeId}/merge`, headers: ADMIN_AUTH,
    payload: { targetId: placeId },
  });
  expect(wrongTarget.statusCode).toBe(400);

  const res = await app.inject({
    method: "POST", url: `/admin/places/${placeId}/merge`, headers: ADMIN_AUTH,
    payload: { targetId: target.id },
  });
  expect(res.statusCode).toBe(204);

  expect(await app.prisma.place.findUnique({ where: { id: placeId } })).toBeNull();
  expect(await app.prisma.footprint.count({ where: { placeId: target.id } })).toBe(1);

  // 迁移后统计:1 足迹 / 1 地点 / 1 城市(芙蓉街 → 济南市)
  const stats = await app.inject({ method: "GET", url: "/me/stats", headers });
  expect(stats.json()).toMatchObject({ footprints: 1, places: 1, cities: 1 });
});
```

Run: `pnpm -C apps/api exec vitest run test/adminPlaces.test.ts` → FAIL。

- [x] **Step 2: 实现**

`apps/api/src/routes/adminPlaces.ts` 追加(import 区补 `import { z } from "zod";` 已有):

```ts
const decisionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("approve"),
    name: z.string().trim().min(1).max(50).optional(),
    parentId: z.string().nullable().optional(),
  }),
  z.object({ action: z.literal("reject") }),
]);

const mergeSchema = z.object({ targetId: z.string() });
```

`adminPlacesRoutes` 内追加三个路由:

```ts
  app.get("/admin/places/pending", { preHandler: requireAdmin }, async () => {
    const rows = await app.prisma.place.findMany({
      where: { status: "PENDING" },
      orderBy: { createdAt: "asc" },
      select: {
        id: true, name: true, lat: true, lng: true, createdAt: true,
        parent: { select: { id: true, name: true } },
        createdBy: { select: { nickname: true } },
      },
    });
    return {
      total: rows.length,
      items: rows.map((p) => ({
        id: p.id,
        name: p.name,
        lat: p.lat,
        lng: p.lng,
        createdAt: p.createdAt.toISOString(),
        parentId: p.parent?.id ?? null,
        parentName: p.parent?.name ?? null,
        creatorNickname: p.createdBy?.nickname ?? "(已注销)",
      })),
    };
  });

  app.post("/admin/places/:id/decision", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = decisionSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    }
    const place = await app.prisma.place.findUnique({ where: { id } });
    if (!place) return reply.code(404).send({ error: "not_found" });
    if (place.status !== "PENDING") return reply.code(409).send({ error: "not_pending" });

    if (body.data.action === "reject") {
      await app.prisma.place.update({ where: { id }, data: { status: "REJECTED" } });
      return reply.code(204).send();
    }

    // approve:可顺手改名/改父级(自动猜不准时人工修正)
    const { name, parentId } = body.data;
    if (parentId != null) {
      const parent = await app.prisma.place.findUnique({ where: { id: parentId } });
      if (!parent || parent.id === id) {
        return reply.code(400).send({ error: "unknown_parent" });
      }
    }
    await app.prisma.place.update({
      where: { id },
      data: {
        status: "ACTIVE",
        ...(name !== undefined ? { name } : {}),
        ...(parentId !== undefined ? { parentId } : {}),
      },
    });
    return reply.code(204).send();
  });

  app.post("/admin/places/:id/merge", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = mergeSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    }
    const source = await app.prisma.place.findUnique({ where: { id } });
    if (!source) return reply.code(404).send({ error: "not_found" });
    if (source.status !== "PENDING") return reply.code(409).send({ error: "not_pending" });

    const target = await app.prisma.place.findUnique({ where: { id: body.data.targetId } });
    if (!target || target.id === id || target.status !== "ACTIVE") {
      return reply.code(400).send({ error: "invalid_target" });
    }

    // 事务:归属数据整体迁移后删除源点。cards/links/子节点在 PENDING 点上理论为空,防御性一并迁。
    await app.prisma.$transaction(async (tx) => {
      await tx.footprint.updateMany({ where: { placeId: id }, data: { placeId: target.id } });
      await tx.card.updateMany({ where: { placeId: id }, data: { placeId: target.id } });
      await tx.placeLink.updateMany({ where: { placeId: id }, data: { placeId: target.id } });
      await tx.place.updateMany({ where: { parentId: id }, data: { parentId: target.id } });
      await tx.place.delete({ where: { id } });
    });
    return reply.code(204).send();
  });
```

- [x] **Step 3: 跑全量 + 提交**

Run: `pnpm -C apps/api exec vitest run`
Expected: PASS

```bash
git add apps/api
git commit -m "feat(api): 地点审核 admin API——队列/通过(改名改父)/合并迁移/拒绝"
```

---

### Task 14: admin 审核 UI

**Files:**
- Create: `apps/admin/app/places/pending/page.tsx`
- Modify: `apps/admin/app/layout.tsx`(导航加"地点审核")
- Modify: `apps/admin/app/places/page.tsx`(加状态列;外链入口仅 ACTIVE 行)

**Interfaces:**
- Consumes: Task 13 的三个 admin 端点 + `GET /places`(requireAdmin,含 status)。

- [x] **Step 1: 导航**

`apps/admin/app/layout.tsx`:找到 `<Link href="/places">地点库</Link>`,其后追加:

```tsx
          <Link href="/places/pending">地点审核</Link>
```

- [x] **Step 2: 地点库列表加状态列**

`apps/admin/app/places/page.tsx`:`type Place` 加 `status: string;`;表头 `<th>层级</th>` 后加 `<th>状态</th>`;行内 `<td>{p.level}</td>` 后加 `<td>{p.status}</td>`;"外链"入口改为:

```tsx
              <td>{p.status === "ACTIVE" ? <Link href={`/places/${p.id}`}>外链</Link> : "—"}</td>
```

(详情接口按用户面可见性过滤,admin token 不是用户会话,非 ACTIVE 详情会 404——待审点的处置全在审核页完成。)

- [x] **Step 3: 审核队列页**

新建 `apps/admin/app/places/pending/page.tsx`:

```tsx
"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

type PendingPlace = {
  id: string; name: string; lat: number; lng: number; createdAt: string;
  parentId: string | null; parentName: string | null; creatorNickname: string;
};
type Place = { id: string; name: string; level: string; status: string };

export default function PendingPlacesPage() {
  const [items, setItems] = useState<PendingPlace[]>([]);
  const [places, setPlaces] = useState<Place[]>([]);
  const [error, setError] = useState("");
  // 每行可编辑的通过参数:改名 / 改父级 / 合并目标
  const [edits, setEdits] = useState<Record<string, { name: string; parentId: string; mergeTargetId: string }>>({});

  const load = useCallback(() => {
    api<{ total: number; items: PendingPlace[] }>("/admin/places/pending")
      .then((d) => {
        setItems(d.items);
        setEdits(Object.fromEntries(d.items.map((i) => [
          i.id, { name: i.name, parentId: i.parentId ?? "", mergeTargetId: "" },
        ])));
      })
      .catch((e) => setError(String(e)));
    api<Place[]>("/places").then(setPlaces).catch((e) => setError(String(e)));
  }, []);
  useEffect(load, [load]);

  async function decide(id: string, payload: object) {
    try {
      await api(`/admin/places/${id}/decision`, { method: "POST", body: JSON.stringify(payload) });
      setItems((prev) => prev.filter((i) => i.id !== id));
    } catch (e) { setError(String(e)); }
  }

  async function merge(id: string, targetId: string) {
    try {
      await api(`/admin/places/${id}/merge`, { method: "POST", body: JSON.stringify({ targetId }) });
      setItems((prev) => prev.filter((i) => i.id !== id));
    } catch (e) { setError(String(e)); }
  }

  const parentOptions = places.filter((p) => p.status === "ACTIVE" && (p.level === "CITY" || p.level === "PROVINCE"));
  const mergeOptions = places.filter((p) => p.status === "ACTIVE");

  return (
    <>
      <h2>地点审核（积压 {items.length}）</h2>
      {error && <p style={{ color: "red" }}>{error}</p>}
      {items.map((item) => {
        const edit = edits[item.id] ?? { name: item.name, parentId: item.parentId ?? "", mergeTargetId: "" };
        const set = (patch: Partial<typeof edit>) =>
          setEdits((prev) => ({ ...prev, [item.id]: { ...edit, ...patch } }));
        return (
          <div className="card-block" key={item.id}>
            <p>
              <strong>{item.name}</strong>｜{item.creatorNickname}｜
              {item.lat.toFixed(4)}, {item.lng.toFixed(4)}｜
              {new Date(item.createdAt).toLocaleString("zh-CN")}｜
              自动挂靠:{item.parentName ?? "(未命中)"}
            </p>
            <p>
              名称 <input value={edit.name} onChange={(e) => set({ name: e.target.value })} />{" "}
              父级{" "}
              <select value={edit.parentId} onChange={(e) => set({ parentId: e.target.value })}>
                <option value="">(链顶)</option>
                {parentOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>{" "}
              <button onClick={() => decide(item.id, {
                action: "approve", name: edit.name, parentId: edit.parentId || null,
              })}>通过</button>{" "}
              <button onClick={() => decide(item.id, { action: "reject" })}>拒绝</button>
            </p>
            <p>
              合并到{" "}
              <select value={edit.mergeTargetId} onChange={(e) => set({ mergeTargetId: e.target.value })}>
                <option value="">(选择已有地点)</option>
                {mergeOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>{" "}
              <button disabled={!edit.mergeTargetId} onClick={() => merge(item.id, edit.mergeTargetId)}>
                合并（足迹随迁）
              </button>
            </p>
          </div>
        );
      })}
      {items.length === 0 && <p>暂无待审地点。</p>}
    </>
  );
}
```

- [x] **Step 4: 浏览器验证**

preview 启动 api(:8799 dev auth)+ admin:用 `POST /auth/dev` 造一个用户 token,`POST /places` 提交两个点(其一同名于已有地点附近)→ admin 审核页:一个"通过"(顺手改父级),一个"合并"到已有点 → 列表消失、地点库状态正确、足迹随迁(可在 DB 或用户端核对)。

- [x] **Step 5: 提交**

```bash
git add apps/admin
git commit -m "feat(admin): 地点审核队列页——通过/改父/合并/拒绝"
```

---

### Task 15: iOS——建点入口(长按地图/选点面板)+ 待审样式 + 公开开关联动

**Files:**
- Modify: `apps/ios/Zhixing/Core/Models.swift`(Pin.status、PlaceRef.status、RemoteAppConfig.placeSubmission)
- Modify: `apps/ios/Zhixing/Core/RemoteConfig.swift`
- Modify: `apps/ios/Zhixing/Map/MapView.swift`(长按手势 + 待审 pin 样式)
- Create: `apps/ios/Zhixing/Place/CreatePlaceSheet.swift`
- Modify: `apps/ios/Zhixing/Map/MapScreen.swift`(建点流转 + 选点面板入口)
- Modify: `apps/ios/Zhixing/Search/SearchSheet.swift`(空态文案)
- Modify: `apps/ios/Zhixing/Footprint/FootprintComposer.swift`、`FootprintEditor.swift`(公开开关联动)
- Modify: `apps/ios/Zhixing/Place/PlaceDrawer.swift`(待审徽标)
- Test: `apps/ios/Tests/PlaceSubmissionTests.swift`(新建)

**Interfaces:**
- Consumes: `POST /places`(Task 10)、pins 的 `status`(Task 11)、`/app-config.placeSubmission`(Task 9)、足迹 place.status(Task 12)。
- Produces: `Pin.status: String?` + `isAwaitingReview`;`PlaceRef.status: String?`;`RemoteConfig.shared.placeSubmission`(缺字段默认 true);`CreatePlaceSheet(lat:lng:onCreated:)`。

- [x] **Step 1: 写失败测试**

新建 `apps/ios/Tests/PlaceSubmissionTests.swift`:

```swift
import XCTest
@testable import Zhixing

final class PlaceSubmissionTests: XCTestCase {
    /// 旧缓存/旧服务端的 pins 无 status 字段:解码不炸,且视为非待审。
    func testPinDecodesWithoutStatus() throws {
        let json = """
        {"id":"p1","name":"什刹海","level":"DISTRICT","parentId":null,
         "lat":39.94,"lng":116.38,"cardCount":3}
        """
        let pin = try APIClient.decoder.decode(Pin.self, from: Data(json.utf8))
        XCTAssertNil(pin.status)
        XCTAssertFalse(pin.isAwaitingReview)
    }

    func testPinAwaitingReviewStates() throws {
        for (status, expected) in [("PENDING", true), ("REJECTED", true), ("ACTIVE", false)] {
            let json = """
            {"id":"p1","name":"x","level":"POI","parentId":null,
             "lat":1,"lng":1,"cardCount":0,"status":"\(status)"}
            """
            let pin = try APIClient.decoder.decode(Pin.self, from: Data(json.utf8))
            XCTAssertEqual(pin.isAwaitingReview, expected, status)
        }
    }

    /// M3 前的服务端 /app-config 没有 placeSubmission——缺字段解码为 nil,开关默认开。
    func testRemoteAppConfigToleratesMissingFlag() throws {
        let json = #"{"shareLandingUrl":"https://example.com/share"}"#
        let config = try APIClient.decoder.decode(RemoteAppConfig.self, from: Data(json.utf8))
        XCTAssertNil(config.placeSubmission)
    }

    /// 足迹内嵌地点带 status;旧响应缺字段容错。
    func testPlaceRefStatusOptional() throws {
        let with = #"{"id":"p1","name":"洪家楼","status":"PENDING"}"#
        XCTAssertEqual(try APIClient.decoder.decode(PlaceRef.self, from: Data(with.utf8)).status, "PENDING")
        let without = #"{"id":"p1","name":"洪家楼"}"#
        XCTAssertNil(try APIClient.decoder.decode(PlaceRef.self, from: Data(without.utf8)).status)
    }
}
```

Run: `scripts/ios-test.sh` → FAIL(编译错误)。

- [x] **Step 2: 模型与配置**

`Models.swift`:

`Pin` 增加(`let cardCount: Int` 之后):

```swift
    /// M3:地点状态。旧缓存/旧服务端无此字段 → nil 视同 ACTIVE。
    let status: String?

    var isAwaitingReview: Bool { status == "PENDING" || status == "REJECTED" }
```

`PlaceRef` 改为:

```swift
struct PlaceRef: Codable {
    let id: String
    let name: String
    /// 足迹编辑器据此禁用公开开关;旧响应缺字段容错。
    let status: String?
}
```

`RemoteAppConfig` 改为:

```swift
struct RemoteAppConfig: Codable {
    let shareLandingUrl: String
    /// M3 前服务端没有该字段:可选容错,消费端缺省按"开"。
    let placeSubmission: Bool?
}
```

`RemoteConfig.swift`:`shareLandingUrl` 属性之后追加:

```swift
    /// 用户申请新地点入口开关:服务端 /app-config 下发;取不到时默认开
    /// (服务端 POST /places 有硬校验兜底,入口多显示不造成越权)。
    private(set) var placeSubmission = true
```

`load()` 成功分支追加一行:

```swift
            placeSubmission = config.placeSubmission ?? true
```

- [x] **Step 3: 地图长按 + 待审 pin 样式**

`MapView.swift`:

`struct MapView` 属性区 `var onSelect: (Pin) -> Void` 之后追加:

```swift
    /// 地图任意位置长按:回调经纬度,由上层决定是否进入建点流程(开关关闭时上层直接忽略)。
    var onLongPress: (Double, Double) -> Void = { _, _ in }
```

`makeUIView` 中 `map.setRegion(...)` 之前追加:

```swift
        let longPress = UILongPressGestureRecognizer(
            target: context.coordinator, action: #selector(Coordinator.handleLongPress(_:)))
        longPress.minimumPressDuration = 0.5
        map.addGestureRecognizer(longPress)
```

`Coordinator` 内追加:

```swift
        @objc func handleLongPress(_ gesture: UILongPressGestureRecognizer) {
            guard gesture.state == .began, let map = gesture.view as? MKMapView else { return }
            let point = gesture.location(in: map)
            let coordinate = map.convert(point, toCoordinateFrom: map)
            parent.onLongPress(coordinate.latitude, coordinate.longitude)
        }
```

`sync(map:)` 的 hasher 需感知状态变化(审核通过后同 id 的 pin 要重绘),`hasher.combine(parent.pins.map(\.id))` 之后追加:

```swift
            hasher.combine(parent.pins.map(\.status))
```

`viewFor annotation` 中非聚簇分支的配色改为(替换原 `v.markerTintColor`/`v.glyphText` 两行):

```swift
            if pa.pin.isAwaitingReview {
                // 待审/驳回地点:灰 pin + "审"字,与正式点在图面上一眼区分
                v.markerTintColor = .systemGray
                v.glyphText = "审"
            } else {
                v.markerTintColor = pa.isFootprint ? .systemOrange : .systemTeal
                v.glyphText = pa.isFootprint ? "行" : "知"
            }
```

同时 `sync` 中人文层过滤保持 `cardCount > 0`(待审点无卡,不进人文层),但**本人待审点必须可见**——足迹层之外补一类:`annotations` 组装追加:

```swift
            // 本人的待审/驳回点:不属于人文层(无卡)也未必有足迹,单独补进图面,
            // 否则用户刚建完点在地图上找不到它。
            let shownIds = Set(annotations.map(\.pin.id))
            annotations += parent.pins.filter { $0.isAwaitingReview && !shownIds.contains($0.id) }
                .map { PlaceAnnotation(pin: $0, isFootprint: false) }
```

- [x] **Step 4: 建点 sheet**

新建 `apps/ios/Zhixing/Place/CreatePlaceSheet.swift`:

```swift
import SwiftUI

/// 用户申请新地点:坐标来自长按点/当前位置,表单只填名称。
/// 成功回传 Pin(status=PENDING),由地图层刷新 pins 并直接进入足迹撰写。
struct CreatePlaceSheet: View {
    let lat: Double
    let lng: Double
    var onCreated: (Pin) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var saving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("新地点") {
                    TextField("地点名称（必填）", text: $name)
                    LabeledContent("坐标", value: String(format: "%.4f, %.4f", lat, lng))
                }
                Section {
                    Text("提交后由管理员审核；审核通过前仅自己可见，足迹照记不误。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if let error {
                    Text(error).foregroundStyle(.red).font(.footnote)
                }
            }
            .scrollContentBackground(.hidden)
            .background(ZXTheme.canvas)
            .disabled(saving)
            .navigationTitle("创建新地点")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }.disabled(saving)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if saving {
                        ProgressView()
                    } else {
                        Button("提交") { Task { await submit() } }
                            .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                    }
                }
            }
        }
        .interactiveDismissDisabled(saving)
    }

    private struct Body: Encodable {
        let name: String
        let lat: Double
        let lng: Double
    }

    private func submit() async {
        saving = true
        defer { saving = false }
        do {
            let pin: Pin = try await APIClient.shared.post(
                "/places", json: Body(name: name.trimmingCharacters(in: .whitespaces), lat: lat, lng: lng))
            onCreated(pin)
            dismiss()
        } catch let APIError.status(code, body) {
            error = Self.errorCopy(code: code, body: body)
        } catch {
            self.error = "提交失败，请重试"
        }
    }

    /// 服务端错误码 → 用户文案(与 apps/api routes/places.ts 的错误码一一对应)
    static func errorCopy(code: Int, body: String) -> String {
        if code == 409, body.contains("place_exists") { return "已有同名地点，回到地图搜索它直接留足迹吧" }
        if code == 403 { return "新地点申请暂未开放" }
        if code == 429 { return "今天创建的地点有点多了，明天再来吧" }
        return "提交失败，请重试"
    }
}
```

- [x] **Step 5: 地图流转**

`MapScreen.swift`:

状态区追加:

```swift
    @State private var createPlaceDraft: CreatePlaceDraft?
    @State private var pendingCreateDraft: CreatePlaceDraft?
```

文件末尾(PlacePickerSheet 之前)追加:

```swift
/// 建点草稿:仅承载长按/定位得到的坐标,Identifiable 供 sheet(item:) 驱动。
struct CreatePlaceDraft: Identifiable {
    let id = UUID()
    let lat: Double
    let lng: Double
}
```

`MapView(...)` 调用追加参数(在 `onSelect:` 之后):

```swift
                    onSelect: { selected = $0 },
                    onLongPress: { lat, lng in
                        guard RemoteConfig.shared.placeSubmission else { return }
                        createPlaceDraft = CreatePlaceDraft(lat: lat, lng: lng)
                    })
```

(原 `onSelect: { selected = $0 })` 行相应改写。)

`showPlacePicker` 的 sheet 改为:

```swift
        .sheet(isPresented: $showPlacePicker, onDismiss: handlePickerDismissed) {
            PlacePickerSheet(
                pins: pinsCache.pins,
                onPick: { pin in
                    pendingComposerPin = pin
                    showPlacePicker = false
                },
                onCreateAt: { lat, lng in
                    pendingCreateDraft = CreatePlaceDraft(lat: lat, lng: lng)
                    showPlacePicker = false
                })
            .appStores()
        }
```

新增 sheet(挂在 `.sheet(item: $composerPin, ...)` 之前):

```swift
        .sheet(item: $createPlaceDraft, onDismiss: presentPendingComposer) { draft in
            CreatePlaceSheet(lat: draft.lat, lng: draft.lng) { newPin in
                // 刷新 pins(带上新的 PENDING 点),随后 onDismiss 链直接进入撰写器
                Task {
                    try? await pinsCache.load(force: true)
                }
                pendingComposerPin = newPin
                flyTo = newPin
            }
            .appStores()
        }
```

新增方法(`presentPendingComposer` 旁):

```swift
    /// 选点面板关闭后的两条去路:建点(定位命中空白区)或直接进撰写器(选中已有点)。
    private func handlePickerDismissed() {
        if let draft = pendingCreateDraft {
            pendingCreateDraft = nil
            createPlaceDraft = draft
            return
        }
        presentPendingComposer()
    }
```

`.task { ... }` 中 `await load()` 之前追加一行(保证开关在入口渲染前就绪):

```swift
            await RemoteConfig.shared.load()
```

`PlacePickerSheet` 整体替换为:

```swift
/// ［+］选点 sheet:顶部「使用当前位置」一键命中最近地点,其下沿用既有搜索选点不变。
/// 附近无收录地点且开关开启时,给出"以当前位置创建新地点"的出口。
private struct PlacePickerSheet: View {
    let pins: [Pin]
    var onPick: (Pin) -> Void
    var onCreateAt: ((Double, Double) -> Void)? = nil

    @State private var locating = false
    @State private var hint: String?
    @State private var missedLat: Double?
    @State private var missedLng: Double?

    var body: some View {
        VStack(spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                Text("快速选点")
                    .font(.headline)
                Button {
                    Task { await useCurrentLocation() }
                } label: {
                    HStack(spacing: 8) {
                        if locating {
                            ProgressView().controlSize(.small)
                        } else {
                            Image(systemName: "location.fill")
                        }
                        Text("使用当前位置")
                        Spacer()
                    }
                }
                .disabled(locating)
                .buttonStyle(ZXSecondaryButtonStyle())
                if let hint {
                    Text(hint)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                if let lat = missedLat, let lng = missedLng, let onCreateAt,
                   RemoteConfig.shared.placeSubmission {
                    Button {
                        onCreateAt(lat, lng)
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "plus")
                            Text("以当前位置创建新地点")
                            Spacer()
                        }
                    }
                    .buttonStyle(ZXSecondaryButtonStyle())
                }
            }
            .padding(20)
            .background(ZXTheme.canvas)
            Divider()
            SearchSheet(prompt: "搜地点，在那里留足迹", onPick: onPick)
        }
    }

    private func useCurrentLocation() async {
        locating = true
        hint = nil
        missedLat = nil
        missedLng = nil
        defer { locating = false }
        do {
            let coordinate = try await LocationOnce.current()
            if let pin = nearestPin(lat: coordinate.latitude, lng: coordinate.longitude, pins: pins) {
                onPick(pin)
            } else {
                hint = "附近还没有收录的地点，试试搜索"
                missedLat = coordinate.latitude
                missedLng = coordinate.longitude
            }
        } catch LocationError.denied {
            hint = "尚未开启定位权限，请到系统设置中开启后重试"
        } catch LocationError.timeout {
            hint = "定位超时，请重试"
        } catch {
            hint = "定位失败，请重试"
        }
    }
}
```

- [x] **Step 6: 搜索空态文案 + 撰写器/编辑器公开开关联动 + 抽屉徽标**

`SearchSheet.swift` 空结果 `ZXEmptyState` 的 message 改为:

```swift
                            message: RemoteConfig.shared.placeSubmission
                                ? "这次搜索已经记下。也可以长按地图任意位置，直接创建新地点。"
                                : "这次搜索已经记下，会成为后续补充地点与风物内容的线索。")
```

`FootprintComposer.swift`:

属性区追加:

```swift
    /// 地点待审/驳回时禁公开:服务端会 400 place_pending,前端直接不给开
    private var placeAwaitingReview: Bool { pin.isAwaitingReview }
```

「地点」Section 改为:

```swift
                Section("地点") {
                    Text(pin.name)
                    if placeAwaitingReview {
                        Label("新地点审核中", systemImage: "hourglass")
                            .font(.footnote)
                            .foregroundStyle(ZXTheme.oldGold)
                    }
                }
```

「公开」Section 的 Toggle 一行改为:

```swift
                    Toggle("公开这条足迹", isOn: $isPublic)
                        .disabled(createdFootprint != nil || placeAwaitingReview)
                    if placeAwaitingReview {
                        Text("新地点审核通过后，才能公开这里的足迹。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
```

`FootprintEditor.swift`:

属性区追加:

```swift
    private var placeAwaitingReview: Bool {
        footprint.place.status == "PENDING" || footprint.place.status == "REJECTED"
    }
```

「公开」Section 的 Toggle 改为:

```swift
                    Toggle("公开这条足迹", isOn: $isPublic)
                        .disabled(placeAwaitingReview)
                    if placeAwaitingReview {
                        Text("地点审核通过后，才能公开这里的足迹。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
```

`PlaceDrawer.swift` 头部名称行(Task 3 加的路径行之后)追加待审徽标:

```swift
                            if let status = placeDetail?.status, status != "ACTIVE" {
                                Label(status == "PENDING" ? "审核中" : "未通过", systemImage: "hourglass")
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(status == "PENDING" ? ZXTheme.oldGold : ZXTheme.cinnabar)
                            }
```

`Models.swift` 的 `PlaceDetail` 增加(与 links 同批):

```swift
    /// M3:地点状态;旧服务端缺字段容错。
    let status: String?
```

(Task 3/7 的 PlaceDetail 测试 JSON 无 status 键,可选属性兼容。)

- [x] **Step 7: xcodegen + 测试**

```bash
cd apps/ios && xcodegen generate && cd ../..
scripts/ios-test.sh
```

Expected: PASS

- [ ] **Step 8: Catalyst 全链路走查**

> 2026-07-15 自动化验收进度：已确认新版搜索空态、本人待审地点可见、抽屉“审核中”徽标，
> 以及足迹撰写器公开开关禁用。Catalyst 定位请求超时，桌面自动化无法稳定模拟 0.5 秒长按；
> 长按建点/当前位置未命中、审核后变色与远程关停入口仍需在有定位能力的真机或模拟器补走查。

Run: `scripts/mac-dev.sh`
验证清单:
1. 地图长按空白处 → 建点 sheet → 提交 → 自动飞到灰色"审"pin 并弹出足迹撰写器,公开开关禁用且带说明;
2. ［+］选点 → 使用当前位置(附近无点)→ 出现"以当前位置创建新地点";
3. 搜索无结果空态出现长按引导文案;
4. admin 审核通过后,App 重新拉 pins(重进地图或重启),pin 变常规色,编辑该足迹可开公开;
5. 服务端 `ZHIXING_PLACE_SUBMISSION=0` 重启后,长按无反应、两处入口文案/按钮消失。

- [x] **Step 9: 提交**

```bash
git add apps/ios
git commit -m "feat(ios): 用户申请新地点——长按建点/待审样式/公开开关联动,受远程开关控制"
```

---

### Task 16: 文档收尾——运维手册与开关说明

**Files:**
- Modify: `docs/content-ops.md`(补"重跑 import 即补省级层"说明)
- Modify: `docs/deploy.md`(环境变量表加 `ZHIXING_PLACE_SUBMISSION`)

**Interfaces:** 无代码。

- [x] **Step 1: content-ops.md**

在导入命令(import-places/import-regions)相关小节追加:

```markdown
> M3 起数据文件带省级层(直辖市/港澳为省级链顶,普通城市挂省)。两个导入命令幂等,
> 生产升级省市层级 = 直接重跑上面两条 import——存量链顶城市会被原地补挂/升级,
> 不新建重复节点,足迹与风物卡无需迁移。
```

- [x] **Step 2: deploy.md**

环境变量说明处追加:

```markdown
| `ZHIXING_PLACE_SUBMISSION` | 用户申请新地点开关。默认开;置 `0` 关闭(iOS 入口隐藏 + POST /places 返回 403)。地点覆盖度足够后建议关闭以控审核负担。 |
```

- [x] **Step 3: 提交**

```bash
git add docs
git commit -m "docs(ops): M3 省级层迁移说明与地点申请开关"
```

---

## 计划级备注(执行者须知)

1. **对 spec 的两处已批准偏差**(已在 spec 修订记):开关走既有 `GET /app-config` 扩展而非新建 `GET /config`(DRY,iOS RemoteConfig 通道现成);"搜索无结果处创建新地点"因该场景无坐标,改为**文案引导长按地图**,有坐标的"使用当前位置未命中"场景保留真按钮。
2. **顺序敏感**:Task 2 与 5、11 都改 `GET /places/:id`,严格按任务序执行;Task 11 会回改 Task 2/5 写下的断言(计划里已给出最终形状)。
3. **生产迁移**:合并上线后在 VPS 上重跑两条 import 命令即完成省级补层(Task 16 的 runbook);`ZHIXING_PLACE_SUBMISSION` 不设即默认开。
4. iOS 每个任务收尾都跑 `scripts/mac-dev.sh` 走查(用户既定工作流)。
