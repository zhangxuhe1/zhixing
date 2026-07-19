# 风物卡管理列表 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 管理台风物卡页升级为卡片管理列表——新增 `GET /admin/cards`（子树/分类/状态/关键字筛选+分页），前端省市级联组件与地点库共享。

**Architecture:** API 侧新增 `placeSubtreeIds` 子树展开 helper（邻接表 BFS+防环）供 `GET /admin/cards` 做 `placeId IN (...)` 过滤，返回不带 blocks 的轻 DTO `{ total, items }`；admin 侧从 `places/page.tsx` 抽出共享省市级联组件 `RegionCascade`（连同 `LEVEL_LABELS`、`inSubtree`），`cards/page.tsx` 重写为服务端分页的管理列表。App 面端点零改动。

**Tech Stack:** Fastify 5 + zod + Prisma（Postgres 真库测试）；Next.js 15 App Router 客户端 fetch。

**Spec:** docs/superpowers/specs/2026-07-18-admin-cards-list-design.md

## Global Constraints

- ESM + TS strict + NodeNext：apps/api 内相对导入必须带 `.js` 后缀（如 `"../placeSubtree.js"`）。
- 注释/提交信息写中文；conventional commits（`feat(api): ...` / `refactor(admin): ...`）。
- 错误形状统一 `{ error: string, detail?: any }`；query 校验失败返回 400 `{ error: "invalid_query" }`（对齐 places.ts 惯例）。
- DTO 逐字段组装，严禁直接返回 Prisma 实体；列表 DTO 不带 blocks/sources。
- 测试打真库：需先 `pnpm db:up`（Docker）+ `pnpm -C packages/db push:test`；本计划**不新增表**，无需改 TRUNCATE 清单。
- vitest 强制串行（fileParallelism: false），勿开并行。
- admin 无测试基建：以 `pnpm --filter @zhixing/admin build` 做类型检查。
- 不改 package.json 的 packageManager 字段；不动 App 面端点（`GET /places/:id/cards`、`GET /cards/:id`）。
- 工作分支：`feat/admin-cards-list`（已存在，spec 已在其上提交）。

---

### Task 1: `placeSubtreeIds` 子树展开 helper

**Files:**
- Create: `apps/api/src/placeSubtree.ts`
- Test: `apps/api/test/placeSubtree.test.ts`

**Interfaces:**
- Consumes: `@zhixing/db` 的 `PrismaClient`（与 `apps/api/src/placeAncestors.ts` 同款导入）。
- Produces: `placeSubtreeIds(prisma: PrismaClient, rootId: string): Promise<string[]>` —— 返回 rootId 整棵子树（**含自身**）的地点 id 列表；rootId 不存在时返回 `[rootId]`（上游 `IN` 查询自然得空集）；脏数据成环时靠 visited 去重终止。Task 2 依赖此签名。

- [x] **Step 1: 写失败测试**

创建 `apps/api/test/placeSubtree.test.ts`：

```ts
import { afterAll, beforeEach, expect, test } from "vitest";
import { placeSubtreeIds } from "../src/placeSubtree.js";
import { resetDb, testApp } from "./helpers.js";

const app = testApp();
beforeEach(() => resetDb(app));
afterAll(async () => app.close());

test("子树展开：含根自身与全部子孙，不含兄弟；根不存在退化为 [rootId]", async () => {
  const prov = await app.prisma.place.create({
    data: { name: "甲省", level: "PROVINCE", lat: 30, lng: 110 },
  });
  const city = await app.prisma.place.create({
    data: { name: "乙市", level: "CITY", parentId: prov.id, lat: 30, lng: 110 },
  });
  const poi = await app.prisma.place.create({
    data: { name: "丙点", level: "POI", parentId: city.id, lat: 30, lng: 110 },
  });
  const other = await app.prisma.place.create({
    data: { name: "丁省", level: "PROVINCE", lat: 31, lng: 111 },
  });

  const ids = await placeSubtreeIds(app.prisma, prov.id);
  expect(new Set(ids)).toEqual(new Set([prov.id, city.id, poi.id]));
  expect(ids).not.toContain(other.id);

  expect(await placeSubtreeIds(app.prisma, poi.id)).toEqual([poi.id]);
  expect(await placeSubtreeIds(app.prisma, "ghost")).toEqual(["ghost"]);
});

test("脏数据成环不死循环", async () => {
  // 管理接口有 cyclic_parent 防护，这里绕过路由直写库造环
  const a = await app.prisma.place.create({
    data: { name: "环甲", level: "CITY", lat: 30, lng: 110 },
  });
  const b = await app.prisma.place.create({
    data: { name: "环乙", level: "CITY", parentId: a.id, lat: 30, lng: 110 },
  });
  await app.prisma.place.update({ where: { id: a.id }, data: { parentId: b.id } });

  const ids = await placeSubtreeIds(app.prisma, a.id);
  expect(new Set(ids)).toEqual(new Set([a.id, b.id]));
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/api exec vitest run test/placeSubtree.test.ts`
Expected: FAIL——`Cannot find module '../src/placeSubtree.js'`

- [x] **Step 3: 写实现**

创建 `apps/api/src/placeSubtree.ts`：

```ts
import type { PrismaClient } from "@zhixing/db";

/**
 * 展开 rootId 整棵子树（含自身）的地点 id 列表。一次全量取 (id, parentId) 建
 * 邻接表后向下 BFS——树深 ≤4、千行量级毫秒级；visited 防脏数据成环。
 * rootId 不存在时退化为 [rootId]（上游 IN 查询自然得空集）。
 */
export async function placeSubtreeIds(
  prisma: PrismaClient,
  rootId: string,
): Promise<string[]> {
  const rows = await prisma.place.findMany({ select: { id: true, parentId: true } });
  const children = new Map<string, string[]>();
  for (const r of rows) {
    if (r.parentId == null) continue;
    const list = children.get(r.parentId);
    if (list) list.push(r.id);
    else children.set(r.parentId, [r.id]);
  }
  const visited = new Set<string>([rootId]);
  const queue = [rootId];
  for (let i = 0; i < queue.length; i++) {
    for (const child of children.get(queue[i]) ?? []) {
      if (visited.has(child)) continue;
      visited.add(child);
      queue.push(child);
    }
  }
  return queue;
}
```

- [x] **Step 4: 跑测试确认通过**

Run: `pnpm -C apps/api exec vitest run test/placeSubtree.test.ts`
Expected: PASS（2 个用例）

- [x] **Step 5: 提交**

```bash
git add apps/api/src/placeSubtree.ts apps/api/test/placeSubtree.test.ts
git commit -m "feat(api): placeSubtree 子树展开 helper——邻接表 BFS+visited 防环"
```

---

### Task 2: `GET /admin/cards` 管理列表端点

**Files:**
- Modify: `apps/api/src/routes/cards.ts`
- Test: `apps/api/test/adminCards.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `placeSubtreeIds(prisma, rootId): Promise<string[]>`；现有 `requireAdmin`（`../auth.js`）。
- Produces: `GET /admin/cards`（requireAdmin）。query 全可选：`under`（placeId，子树语义）、`category`（五分类枚举）、`status`（AI_GENERATED/REVIEWED/RETIRED，不传=全部）、`q`（标题关键字，大小写不敏感 contains）、`page`（默认 1）、`pageSize`（默认 50，上限 200）。响应 `{ total: number, items: Array<{ id, title, category, status, createdAt, placeId, placeName }> }`，按 createdAt desc、id desc。Task 4 前端依赖此 query/DTO 形状。

- [x] **Step 1: 写失败测试**

创建 `apps/api/test/adminCards.test.ts`：

```ts
import { afterAll, beforeEach, expect, test } from "vitest";
import { ADMIN_AUTH, resetDb, testApp } from "./helpers.js";

const app = testApp();
beforeEach(() => resetDb(app));
afterAll(async () => app.close());

/** 两省树：河北省→保定市→莲池区→直隶总督署；山东省→济南市→大明湖 */
async function makeTree() {
  const hebei = await app.prisma.place.create({
    data: { name: "河北省", level: "PROVINCE", lat: 38.04, lng: 114.51 },
  });
  const baoding = await app.prisma.place.create({
    data: { name: "保定市", level: "CITY", parentId: hebei.id, lat: 38.87, lng: 115.46 },
  });
  const lianchi = await app.prisma.place.create({
    data: { name: "莲池区", level: "DISTRICT", parentId: baoding.id, lat: 38.88, lng: 115.5 },
  });
  const zongdushu = await app.prisma.place.create({
    data: { name: "直隶总督署", level: "POI", parentId: lianchi.id, lat: 38.874, lng: 115.49 },
  });
  const shandong = await app.prisma.place.create({
    data: { name: "山东省", level: "PROVINCE", lat: 36.67, lng: 117.02 },
  });
  const jinan = await app.prisma.place.create({
    data: { name: "济南市", level: "CITY", parentId: shandong.id, lat: 36.65, lng: 117.12 },
  });
  const daminghu = await app.prisma.place.create({
    data: { name: "大明湖", level: "POI", parentId: jinan.id, lat: 36.678, lng: 117.02 },
  });
  return { hebei, baoding, lianchi, zongdushu, shandong, jinan, daminghu };
}

type CardOver = {
  title?: string;
  category?: "CUSTOMS" | "FOOD" | "DIALECT" | "ANECDOTE" | "PLACE_NAME";
  status?: "AI_GENERATED" | "REVIEWED" | "RETIRED";
  createdAt?: Date;
};

function makeCard(placeId: string, over: CardOver = {}) {
  return app.prisma.card.create({
    data: {
      placeId,
      category: over.category ?? "ANECDOTE",
      title: over.title ?? "无题",
      status: over.status ?? "AI_GENERATED",
      sources: [],
      ...(over.createdAt ? { createdAt: over.createdAt } : {}),
    },
  });
}

function list(query: string) {
  return app.inject({ method: "GET", url: `/admin/cards${query}`, headers: ADMIN_AUTH });
}

test("under 子树筛选：含自身与全部子孙，兄弟省不串", async () => {
  const t = await makeTree();
  await makeCard(t.hebei.id, { title: "省卡" });
  await makeCard(t.baoding.id, { title: "市卡" });
  await makeCard(t.lianchi.id, { title: "区卡" });
  await makeCard(t.zongdushu.id, { title: "POI卡" });
  await makeCard(t.daminghu.id, { title: "外省卡" });

  const province = (await list(`?under=${t.hebei.id}`)).json();
  expect(province.total).toBe(4);
  expect(province.items.map((c: { title: string }) => c.title)).not.toContain("外省卡");

  expect((await list(`?under=${t.baoding.id}`)).json().total).toBe(3);

  const poi = (await list(`?under=${t.zongdushu.id}`)).json();
  expect(poi.total).toBe(1);
  expect(poi.items[0].placeName).toBe("直隶总督署");
});

test("分类/状态/关键字筛选；RETIRED 默认可见", async () => {
  const t = await makeTree();
  await makeCard(t.zongdushu.id, { title: "总督署掌故", category: "ANECDOTE", status: "REVIEWED" });
  await makeCard(t.zongdushu.id, { title: "Baoding驴肉火烧", category: "FOOD", status: "AI_GENERATED" });
  await makeCard(t.zongdushu.id, { title: "已退休的卡", category: "FOOD", status: "RETIRED" });

  expect((await list("")).json().total).toBe(3); // 不传 status = 全部，含 RETIRED

  expect((await list("?category=FOOD")).json().total).toBe(2);

  const retired = (await list("?status=RETIRED")).json();
  expect(retired.total).toBe(1);
  expect(retired.items[0].title).toBe("已退休的卡");

  const kw = (await list("?q=baoding")).json(); // 大小写不敏感 contains
  expect(kw.total).toBe(1);
  expect(kw.items[0].title).toBe("Baoding驴肉火烧");

  const combo = (await list(`?under=${t.hebei.id}&category=FOOD&status=AI_GENERATED`)).json();
  expect(combo.total).toBe(1);
});

test("分页稳定（createdAt desc）与轻 DTO（无 blocks/sources）", async () => {
  const t = await makeTree();
  await makeCard(t.zongdushu.id, { title: "第一张", createdAt: new Date("2026-07-01T00:00:00Z") });
  await makeCard(t.zongdushu.id, { title: "第二张", createdAt: new Date("2026-07-02T00:00:00Z") });
  const third = await makeCard(t.zongdushu.id, {
    title: "第三张", createdAt: new Date("2026-07-03T00:00:00Z"),
  });
  await app.prisma.cardBlock.create({
    data: { cardId: third.id, type: "TEXT", text: "正文", order: 0 },
  });

  const page1 = (await list("?pageSize=2&page=1")).json();
  expect(page1.total).toBe(3);
  expect(page1.items.map((c: { title: string }) => c.title)).toEqual(["第三张", "第二张"]);
  const page2 = (await list("?pageSize=2&page=2")).json();
  expect(page2.items.map((c: { title: string }) => c.title)).toEqual(["第一张"]);

  // 轻 DTO 回归：即使卡带 blocks，列表项也不携带 blocks/sources，且带 placeName
  const serialized = JSON.stringify(page1);
  expect(serialized).not.toContain("blocks");
  expect(serialized).not.toContain("sources");
  expect(page1.items[0].placeName).toBe("直隶总督署");
});

test("未鉴权 401；非法参数 400；under 不存在返回空集", async () => {
  const anon = await app.inject({ method: "GET", url: "/admin/cards" });
  expect(anon.statusCode).toBe(401);

  expect((await list("?page=0")).statusCode).toBe(400);
  expect((await list("?pageSize=999")).statusCode).toBe(400);
  expect((await list("?status=NOPE")).statusCode).toBe(400);

  const ghost = await list("?under=no-such-place");
  expect(ghost.statusCode).toBe(200);
  expect(ghost.json()).toEqual({ total: 0, items: [] });
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/api exec vitest run test/adminCards.test.ts`
Expected: FAIL——`/admin/cards` 路由不存在，`statusCode` 404 ≠ 预期

- [x] **Step 3: 写实现**

修改 `apps/api/src/routes/cards.ts`。

3a. 顶部 import 增加（注意 `.js` 后缀）：

```ts
import { placeSubtreeIds } from "../placeSubtree.js";
```

3b. 把 `createCardSchema` 里内联的 category 枚举抽为共享常量（DRY），即把：

```ts
const createCardSchema = z.object({
  placeId: z.string(),
  category: z.enum(["CUSTOMS", "FOOD", "DIALECT", "ANECDOTE", "PLACE_NAME"]),
```

改为：

```ts
const categoryEnum = z.enum(["CUSTOMS", "FOOD", "DIALECT", "ANECDOTE", "PLACE_NAME"]);

const createCardSchema = z.object({
  placeId: z.string(),
  category: categoryEnum,
```

3c. 在 `statusSchema` 之后新增 query schema：

```ts
const adminListQuerySchema = z.object({
  under: z.string().min(1).optional(),
  category: categoryEnum.optional(),
  status: z.enum(["AI_GENERATED", "REVIEWED", "RETIRED"]).optional(),
  q: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
```

3d. 在 `cardsRoutes` 内、`app.post("/admin/cards", ...)` 之前新增路由：

```ts
  // 管理列表：子树/分类/状态/标题关键字筛选 + 分页；逐字段轻 DTO，不带 blocks
  app.get("/admin/cards", { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = adminListQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });
    const { under, category, status, q, page, pageSize } = parsed.data;

    const keyword = q?.trim() ?? "";
    const where = {
      ...(under ? { placeId: { in: await placeSubtreeIds(app.prisma, under) } } : {}),
      ...(category ? { category } : {}),
      ...(status ? { status } : {}),
      ...(keyword !== ""
        ? { title: { contains: keyword, mode: "insensitive" as const } }
        : {}),
    };
    const [total, rows] = await Promise.all([
      app.prisma.card.count({ where }),
      app.prisma.card.findMany({
        where,
        include: { place: { select: { name: true } } },
        // 批量导入会撞 createdAt 时间戳，补 id 兜底保证翻页稳定
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      total,
      items: rows.map((c) => ({
        id: c.id,
        title: c.title,
        category: c.category,
        status: c.status,
        createdAt: c.createdAt,
        placeId: c.placeId,
        placeName: c.place.name,
      })),
    };
  });
```

- [x] **Step 4: 跑测试确认通过**

Run: `pnpm -C apps/api exec vitest run test/adminCards.test.ts`
Expected: PASS（4 个用例）

- [x] **Step 5: 跑 api 全量测试防回归**

Run: `pnpm -C apps/api exec vitest run`
Expected: 全部 PASS（需 Docker 起着 `pnpm db:up`；若首次或改过 schema，先 `pnpm -C packages/db push:test`）

- [x] **Step 6: 提交**

```bash
git add apps/api/src/routes/cards.ts apps/api/test/adminCards.test.ts
git commit -m "feat(api): GET /admin/cards 管理列表——子树/分类/状态/关键字筛选+分页轻 DTO"
```

---

### Task 3: 抽共享省市级联组件 `RegionCascade`，地点库改用

**Files:**
- Create: `apps/admin/app/region-cascade.tsx`
- Modify: `apps/admin/app/places/page.tsx`
- Modify: `apps/admin/app/places/place-form.tsx`（`LEVEL_LABELS` 移出，改为从共享文件导入）

**Interfaces:**
- Consumes: 现状 `places/page.tsx` 的级联逻辑（省=链顶、市=省的 CITY 子节点、失效复位、上溯判子树）。
- Produces（Task 4 依赖）：
  - `RegionCascade` 组件，props `{ places: RegionPlace[]; provinceId: string; cityId: string; onChange: (provinceId: string, cityId: string) => void; disabled?: boolean }`——省变更自动携带 `cityId=""` 回调；失效复位也走 `onChange`。
  - `type RegionPlace = { id: string; name: string; level: string; parentId: string | null }`。
  - `LEVEL_LABELS: Record<string, string>`（从 place-form 迁来，值不变：省/市/区县/点位）。
  - `inSubtree(parentById: Map<string, string | null>, rootId: string, id: string): boolean`（32 跳保险丝）。

- [x] **Step 1: 创建共享组件**

创建 `apps/admin/app/region-cascade.tsx`（放 app 根，与 token-bar.tsx 同规；级联注释随逻辑从 places/page.tsx 迁入）：

```tsx
"use client";
import { useEffect, useMemo } from "react";

export type RegionPlace = { id: string; name: string; level: string; parentId: string | null };

export const LEVEL_LABELS: Record<string, string> = {
  PROVINCE: "省", CITY: "市", DISTRICT: "区县", POI: "点位",
};

/** 沿父链上溯判归属（含根自身；树深≤4）；32 跳保险丝防御脏数据成环 */
export function inSubtree(
  parentById: Map<string, string | null>,
  rootId: string,
  id: string,
): boolean {
  let cur: string | null | undefined = id;
  for (let hops = 0; cur != null && hops < 32; hops++) {
    if (cur === rootId) return true;
    cur = parentById.get(cur);
  }
  return false;
}

/** 省市两级级联下拉。省变更自动清市；已选项不再出现在数据源里时自动复位（走 onChange）。 */
export function RegionCascade({ places, provinceId, cityId, onChange, disabled }: {
  places: RegionPlace[];
  provinceId: string;
  cityId: string;
  onChange: (provinceId: string, cityId: string) => void;
  disabled?: boolean;
}) {
  // 省下拉取链顶(parentId 为空)而非 level=PROVINCE——与服务端 trips/footprints 的
  // 链顶语义一致;遗留"无父级城市"这类脏数据也会出现在下拉(带层级标注),整棵子树
  // 保持可达且可当场改父修复
  const provinces = useMemo(
    () =>
      places
        .filter((p) => !p.parentId)
        .sort((a, b) => a.name.localeCompare(b.name, "zh")),
    [places],
  );
  const cities = useMemo(
    () =>
      places
        .filter((p) => p.parentId === provinceId && p.level === "CITY")
        .sort((a, b) => a.name.localeCompare(b.name, "zh")),
    [places, provinceId],
  );

  // 数据源刷新后已选省市可能不再出现在下拉里,而 React 会把下拉重同步到首项显示、
  // 过滤却仍卡在旧根——对照下拉数据源校验,失效即复位
  useEffect(() => {
    if (provinceId && !provinces.some((p) => p.id === provinceId)) {
      onChange("", "");
    } else if (cityId && !cities.some((c) => c.id === cityId)) {
      onChange(provinceId, "");
    }
  }, [provinces, cities, provinceId, cityId, onChange]);

  return (
    <>
      <select value={provinceId} disabled={disabled}
        onChange={(e) => onChange(e.target.value, "")}>
        <option value="">全部省份</option>
        {provinces.map((p) => (
          <option key={p.id} value={p.id}>
            {p.level === "PROVINCE" ? p.name : `${p.name}（${LEVEL_LABELS[p.level] ?? p.level}）`}
          </option>
        ))}
      </select>{" "}
      <select value={cityId} onChange={(e) => onChange(provinceId, e.target.value)}
        disabled={disabled || provinceId === "" || cities.length === 0}>
        <option value="">全部市</option>
        {cities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    </>
  );
}
```

- [x] **Step 2: 地点库页改用共享组件**

重写 `apps/admin/app/places/page.tsx` 为：

```tsx
"use client";
import Link from "next/link";
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { inSubtree, LEVEL_LABELS, RegionCascade } from "../region-cascade";
import { PlaceForm, type PlaceRow } from "./place-form";

const LEVELS = ["PROVINCE", "CITY", "DISTRICT", "POI"] as const;

export default function PlacesPage() {
  const [places, setPlaces] = useState<PlaceRow[]>([]);
  const [error, setError] = useState("");
  const [levelFilter, setLevelFilter] = useState("");
  const [provinceId, setProvinceId] = useState("");
  const [cityId, setCityId] = useState("");
  const [keyword, setKeyword] = useState("");
  const [editing, setEditing] = useState<PlaceRow | "create" | null>(null);

  const load = useCallback(() => {
    api<PlaceRow[]>("/places")
      .then((ps) => { setPlaces(ps); setError(""); })
      .catch((e) => setError(String(e)));
  }, []);
  useEffect(load, [load]);

  const nameById = useMemo(() => new Map(places.map((p) => [p.id, p.name])), [places]);
  const parentById = useMemo(() => new Map(places.map((p) => [p.id, p.parentId])), [places]);
  const rootId = cityId || provinceId;

  const onRegion = useCallback((p: string, c: string) => {
    setProvinceId(p);
    setCityId(c);
  }, []);

  // 关键字经 useDeferredValue 降优先级:逐键输入时表格重渲不阻塞输入;比对大小写不敏感
  const kw = useDeferredValue(keyword).trim().toLowerCase();
  const shown = places.filter(
    (p) =>
      (rootId === "" || inSubtree(parentById, rootId, p.id)) &&
      (levelFilter === "" || p.level === levelFilter) &&
      (kw === "" || p.name.toLowerCase().includes(kw)),
  );

  return (
    <>
      <h2>地点库（{shown.length}）</h2>
      {error && <p style={{ color: "red" }}>{error}</p>}
      {/* 表单打开期间筛选整体禁用(与新建按钮同规):避免行在编辑中途被筛掉造成"消失"错觉 */}
      <p>
        <RegionCascade places={places} provinceId={provinceId} cityId={cityId}
          onChange={onRegion} disabled={editing !== null} />{" "}
        <select value={levelFilter} disabled={editing !== null}
          onChange={(e) => setLevelFilter(e.target.value)}>
          <option value="">全部层级</option>
          {LEVELS.map((l) => <option key={l} value={l}>{LEVEL_LABELS[l]}</option>)}
        </select>{" "}
        <input placeholder="按名称搜索…" value={keyword} disabled={editing !== null}
          onChange={(e) => setKeyword(e.target.value)} />{" "}
        <button onClick={() => setEditing("create")} disabled={editing !== null}>新建地点</button>
      </p>
      {editing !== null && (
        <PlaceForm
          mode={editing === "create" ? "create" : "edit"}
          initial={editing === "create" ? undefined : editing}
          places={places}
          onDone={() => { setEditing(null); load(); }}
          onCancel={() => setEditing(null)}
        />
      )}
      <table>
        <thead>
          <tr><th>名称</th><th>层级</th><th>父级</th><th>坐标</th><th>操作</th></tr>
        </thead>
        <tbody>
          {shown.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td>{LEVEL_LABELS[p.level] ?? p.level}</td>
              <td>{p.parentId ? nameById.get(p.parentId) ?? "?" : "—"}</td>
              <td>{p.lat.toFixed(3)}, {p.lng.toFixed(3)}</td>
              <td>
                <button onClick={() => setEditing(p)} disabled={editing !== null}>编辑</button>{" "}
                <Link href={`/places/${p.id}`}>外链</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
```

- [x] **Step 3: place-form 的 LEVEL_LABELS 改为导入**

修改 `apps/admin/app/places/place-form.tsx`：删除本地定义

```tsx
export const LEVEL_LABELS: Record<string, string> = {
  PROVINCE: "省", CITY: "市", DISTRICT: "区县", POI: "点位",
};
```

并在顶部 import 区加入：

```tsx
import { LEVEL_LABELS } from "../region-cascade";
```

（`LEVELS` 常量保留在原处；除这两处外该文件不动。全仓只有 places/page.tsx 曾从 place-form 导入 LEVEL_LABELS，Step 2 已改为从共享文件导入。）

- [x] **Step 4: 类型检查**

Run: `pnpm --filter @zhixing/admin build`
Expected: 编译通过，无 TS 报错

- [x] **Step 5: 提交**

```bash
git add apps/admin/app/region-cascade.tsx apps/admin/app/places/page.tsx apps/admin/app/places/place-form.tsx
git commit -m "refactor(admin): 抽共享省市级联组件 RegionCascade——地点库改用，行为不变"
```

---

### Task 4: 风物卡页重写为管理列表

**Files:**
- Modify: `apps/admin/app/cards/page.tsx`（整文件重写）

**Interfaces:**
- Consumes: Task 2 的 `GET /admin/cards`（query：under/category/status/q/page/pageSize；响应 `{ total, items: [{ id, title, category, status, createdAt, placeId, placeName }] }`）；Task 3 的 `RegionCascade` / `RegionPlace` / `LEVEL_LABELS` / `inSubtree`；现有 `api()`（自动带 admin token）。
- Produces: 无下游依赖。

- [x] **Step 1: 重写页面**

重写 `apps/admin/app/cards/page.tsx` 为：

```tsx
"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { inSubtree, LEVEL_LABELS, RegionCascade, type RegionPlace } from "../region-cascade";

type CardRow = {
  id: string; title: string; category: string; status: string;
  createdAt: string; placeId: string; placeName: string;
};

const CATEGORY_ZH: Record<string, string> = {
  CUSTOMS: "习俗", FOOD: "吃食", DIALECT: "方言", ANECDOTE: "掌故", PLACE_NAME: "地名由来",
};
const STATUS_ZH: Record<string, string> = {
  AI_GENERATED: "AI 生成待复核", REVIEWED: "已复核", RETIRED: "已下架",
};
const PAGE_SIZE = 50;

// 请求参数收拢为单个 state:任何筛选变化与 page: 1 同一次更新落地,
// 避免"先按旧页码请求、再重置页码二次请求"的浪费与闪烁
type Filters = {
  provinceId: string; cityId: string; placeId: string;
  category: string; status: string; q: string; page: number;
};
const INITIAL: Filters = {
  provinceId: "", cityId: "", placeId: "", category: "", status: "", q: "", page: 1,
};

export default function CardsPage() {
  const [places, setPlaces] = useState<RegionPlace[]>([]);
  const [keyword, setKeyword] = useState(""); // 输入框即时值;filters.q 是防抖落定值
  const [filters, setFilters] = useState<Filters>(INITIAL);
  const [data, setData] = useState<{ total: number; items: CardRow[] }>({ total: 0, items: [] });
  const [error, setError] = useState("");

  useEffect(() => {
    api<RegionPlace[]>("/places").then(setPlaces).catch((e) => setError(String(e)));
  }, []);

  // 关键字 300ms 防抖:落定后并入 filters 并重置回第 1 页(与其它筛选同规)
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters((f) => (f.q === keyword ? f : { ...f, q: keyword, page: 1 }));
    }, 300);
    return () => clearTimeout(t);
  }, [keyword]);

  useEffect(() => {
    const under = filters.placeId || filters.cityId || filters.provinceId;
    const params = new URLSearchParams();
    if (under) params.set("under", under);
    if (filters.category) params.set("category", filters.category);
    if (filters.status) params.set("status", filters.status);
    if (filters.q.trim() !== "") params.set("q", filters.q.trim());
    params.set("page", String(filters.page));
    params.set("pageSize", String(PAGE_SIZE));
    api<{ total: number; items: CardRow[] }>(`/admin/cards?${params}`)
      .then((d) => { setData(d); setError(""); })
      .catch((e) => setError(String(e)));
  }, [filters]);

  const parentById = useMemo(() => new Map(places.map((p) => [p.id, p.parentId])), [places]);
  const rootId = filters.cityId || filters.provinceId;
  // 地点下拉:当前省/市子树内的区县与点位(不含根自身),中文排序、带层级标注
  const spotOptions = useMemo(
    () =>
      rootId === ""
        ? []
        : places
            .filter(
              (p) =>
                p.id !== rootId &&
                (p.level === "DISTRICT" || p.level === "POI") &&
                inSubtree(parentById, rootId, p.id),
            )
            .sort((a, b) => a.name.localeCompare(b.name, "zh")),
    [places, parentById, rootId],
  );

  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));

  return (
    <>
      <h2>风物卡（{data.total}）</h2>
      {error && <p style={{ color: "red" }}>{error}</p>}
      <p>
        <RegionCascade places={places} provinceId={filters.provinceId} cityId={filters.cityId}
          onChange={(provinceId, cityId) =>
            setFilters((f) => ({ ...f, provinceId, cityId, placeId: "", page: 1 }))} />{" "}
        <select value={filters.placeId} disabled={rootId === ""}
          onChange={(e) => setFilters((f) => ({ ...f, placeId: e.target.value, page: 1 }))}>
          <option value="">全部地点</option>
          {spotOptions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}（{LEVEL_LABELS[p.level] ?? p.level}）
            </option>
          ))}
        </select>{" "}
        <select value={filters.category}
          onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value, page: 1 }))}>
          <option value="">全部分类</option>
          {Object.entries(CATEGORY_ZH).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>{" "}
        <select value={filters.status}
          onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value, page: 1 }))}>
          <option value="">全部状态</option>
          {Object.entries(STATUS_ZH).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>{" "}
        <input placeholder="按标题搜索…" value={keyword}
          onChange={(e) => setKeyword(e.target.value)} />
      </p>
      <table>
        <thead>
          <tr><th>标题</th><th>地点</th><th>分类</th><th>状态</th><th>创建时间</th></tr>
        </thead>
        <tbody>
          {data.items.map((c) => (
            <tr key={c.id}>
              <td><Link href={`/cards/${c.id}`}>{c.title}</Link></td>
              <td>{c.placeName}</td>
              <td>{CATEGORY_ZH[c.category] ?? c.category}</td>
              <td><span className={`badge ${c.status}`}>{STATUS_ZH[c.status] ?? c.status}</span></td>
              <td>{new Date(c.createdAt).toLocaleDateString("zh-CN")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        <button disabled={filters.page <= 1}
          onClick={() => setFilters((f) => ({ ...f, page: f.page - 1 }))}>上一页</button>{" "}
        第 {filters.page} / {totalPages} 页（共 {data.total} 条）{" "}
        <button disabled={filters.page >= totalPages}
          onClick={() => setFilters((f) => ({ ...f, page: f.page + 1 }))}>下一页</button>
      </p>
    </>
  );
}
```

- [x] **Step 2: 类型检查**

Run: `pnpm --filter @zhixing/admin build`
Expected: 编译通过，无 TS 报错

- [x] **Step 3: 提交**

```bash
git add apps/admin/app/cards/page.tsx
git commit -m "feat(admin): 风物卡页重写为管理列表——省市地点级联+分类/状态/标题筛选+分页"
```

---

### Task 5: 全量验证与人工走查

**Files:** 无新改动（只跑验证；如走查发现问题，另行修复提交）

- [x] **Step 1: api 全量测试**

Run: `pnpm -C apps/api exec vitest run`
Expected: 全部 PASS

- [x] **Step 2: admin 构建**

Run: `pnpm --filter @zhixing/admin build`
Expected: 编译通过

- [x] **Step 3: 起本地环境交人工走查**

依次：`pnpm db:up` → `pnpm --filter @zhixing/api dev`（:8787）→ `pnpm --filter @zhixing/admin dev`（:3000），浏览器开 http://localhost:3000/cards。走查清单（admin 是网页，浏览器走查即可，不涉及 Mac Catalyst）：

1. 无筛选：全库卡片按创建时间倒序分页展示，h2 计数=总数；
2. 选省 → 表格收敛到该省子树的卡；再选市 → 进一步收敛；地点下拉出现该市的区县/点位（带层级标注、中文排序），选中后只见该点子树的卡；
3. 直辖市（如北京市）：市下拉禁用，地点下拉直列区县/点位；
4. 分类、状态各自与组合过滤正确；状态=已下架能看到 RETIRED 卡（旧页面看不到）；
5. 标题关键字：连续输入只在停顿 300ms 后发一次请求（DevTools Network 验证），大小写不敏感；
6. 翻页：上一页/下一页边界禁用；任何筛选变化后回到第 1 页；
7. 点标题进详情页，「标记已复核 / 下架」照常工作；
8. 地点库页（/places）回归：级联/层级/关键字/新建/编辑行为与改造前一致。

- [x] **Step 4: 勾选计划复选框并提交计划文件**

```bash
git add docs/superpowers/plans/2026-07-18-admin-cards-list.md
git commit -m "docs(plan): 风物卡管理列表实施计划全任务勾选"
```
