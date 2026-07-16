# M3 地点域增强实施计划(省市层级 / 地点外链)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐省级数据让统计归并生效并全端显示位置路径;给地点挂管理员维护的外部攻略链接。

**Architecture:** 两段推进 A→C。A 纯数据+DTO(schema 零改动):导入脚本建省挂城(幂等补挂存量),API 吐 `ancestors` 祖先链,iOS 显示路径。C 新增 `PlaceLink` 表+admin CRUD+iOS 攻略区块。

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

### Task 8: 文档收尾——省级层迁移说明

**Files:**
- Modify: `docs/content-ops.md`(补"重跑 import 即补省级层"说明)

**Interfaces:** 无代码。

- [x] **Step 1: content-ops.md**

在导入命令(import-places/import-regions)相关小节追加:

```markdown
> M3 起数据文件带省级层(直辖市/港澳为省级链顶,普通城市挂省)。两个导入命令幂等,
> 生产升级省市层级 = 直接重跑上面两条 import——存量链顶城市会被原地补挂/升级,
> 不新建重复节点,足迹与风物卡无需迁移。
```

- [x] **Step 2: 提交**

```bash
git add docs/content-ops.md
git commit -m "docs(ops): 补充 M3 省级层迁移说明"
```

---

## 计划级备注(执行者须知)

1. **顺序敏感**:Task 2 与 5 都改 `GET /places/:id`,严格按任务序执行。
2. **生产迁移**:合并上线后在 VPS 上重跑两条 import 命令即完成省级补层(Task 8 的 runbook)。
3. iOS 每个任务收尾都跑 `scripts/mac-dev.sh` 走查(用户既定工作流)。
