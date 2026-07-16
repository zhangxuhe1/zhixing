# 地点录入闭环·第一期（管理端建点/编辑）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 管理员能在 admin 控制台新建/编辑地点（含高德地图选点），API 补 PATCH 与错误加固，全库坐标系约定 GCJ-02 落文档。

**Architecture:** 复用既有可信写入面 `adminPlaces.ts`（requireAdmin）：POST 加固 + 新增 PATCH；admin 地点页从只读表格升级为「列表+表单」，地图选点是表单的纯增强层（未配高德 key 自动退化为手动输入经纬度）。不新增任何用户建点端点（places.test.ts 守卫必须保持通过）。

**Tech Stack:** Fastify 5 + zod + Prisma（api）；Next.js 15 App Router 纯客户端 fetch + 朴素 CSS（admin）；高德 JS API 2.0（script 注入，无 npm 依赖）。

**Spec:** `docs/superpowers/specs/2026-07-16-place-intake-design.md`（第一期部分）

## Global Constraints

- ESM + TS strict + NodeNext：相对导入必须带 `.js` 后缀（api 侧）。
- 错误形状统一 `{ error: string, detail?: any }`；zod 校验失败返回 400 `invalid_body`。
- 注释/文档/commit 中文，conventional commits（`feat(api): ...`）。
- 坐标系：全库 Place.lat/lng 为 **GCJ-02**（本计划 Task 1 落文档）；高德 API 坐标序是 **[lng, lat]**（与常见 lat,lng 相反，易错）。
- 测试用真实 Postgres：先 `pnpm db:up`（Docker 不在跑先 `open -a Docker`）。本计划**无 schema 变更**，无需 push:test，无需动 TRUNCATE 清单。
- vitest 强制串行（fileParallelism: false），不要开并行。
- admin 架构约束：全部数据走 `lib/api.ts` 客户端 fetch，token 在 localStorage `zx_admin_token`，无服务端数据访问；样式用内联/朴素 CSS，与现有页面一致。
- dev 环境 ADMIN_TOKEN 默认 `dev-admin-token`（apps/api/src/config.ts:3）。

---

### Task 1: POST /admin/places 加固 + GCJ-02 约定落文档

**Files:**
- Modify: `apps/api/src/routes/adminPlaces.ts`
- Create: `apps/api/test/adminPlaces.test.ts`
- Modify: `packages/db/prisma/schema.prisma`（Place 模型注释）
- Modify: `CLAUDE.md`（Conventions 一行）

**Interfaces:**
- Consumes: 既有 `POST /admin/places`（createPlaceSchema：name/level/parentId?/lat/lng/intro?）、`ADMIN_AUTH`/`resetDb`/`testApp`（test/helpers.ts）。
- Produces: `POST /admin/places` 新错误契约——parentId 不存在 → 400 `{error:"unknown_parent"}`；同父（含链顶无父）重名 → 409 `{error:"duplicate_name"}`。Task 3 的表单错误文案依赖这两个 error 字符串。

- [ ] **Step 1: 写失败测试**

新建 `apps/api/test/adminPlaces.test.ts`：

```ts
import { afterAll, beforeEach, expect, test } from "vitest";
import { ADMIN_AUTH, resetDb, testApp } from "./helpers.js";

const app = testApp();
beforeEach(() => resetDb(app));
afterAll(async () => app.close());

// as const 保 level 为字面量类型,否则推宽成 string 过不了 prisma.create 的枚举检查
const base = { name: "测试点", level: "POI", lat: 39.94, lng: 116.38 } as const;

test("POST /admin/places：parentId 不存在返回 400 unknown_parent", async () => {
  const res = await app.inject({
    method: "POST", url: "/admin/places", headers: ADMIN_AUTH,
    payload: { ...base, parentId: "nope" },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({ error: "unknown_parent" });
  expect(await app.prisma.place.count()).toBe(0);
});

test("POST /admin/places：同父重名返回 409 duplicate_name", async () => {
  const city = await app.prisma.place.create({
    data: { name: "北京市", level: "CITY", lat: 39.9, lng: 116.4 },
  });
  await app.prisma.place.create({ data: { ...base, parentId: city.id } });
  const res = await app.inject({
    method: "POST", url: "/admin/places", headers: ADMIN_AUTH,
    payload: { ...base, parentId: city.id },
  });
  expect(res.statusCode).toBe(409);
  expect(res.json()).toEqual({ error: "duplicate_name" });
});

test("POST /admin/places：链顶（无父）重名同样 409——unique 索引对 NULL 不生效，靠显式预检", async () => {
  await app.prisma.place.create({
    data: { name: "北京市", level: "PROVINCE", lat: 39.9, lng: 116.4 },
  });
  const res = await app.inject({
    method: "POST", url: "/admin/places", headers: ADMIN_AUTH,
    payload: { name: "北京市", level: "PROVINCE", lat: 39.9, lng: 116.4 },
  });
  expect(res.statusCode).toBe(409);
  expect(res.json()).toEqual({ error: "duplicate_name" });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/api exec vitest run test/adminPlaces.test.ts`
Expected: 3 个测试 FAIL——unknown_parent 用例是 500（Prisma P2003 外键炸）；两个重名用例分别是 500（P2002）和 201（NULL 父级 unique 不拦）。

- [ ] **Step 3: 实现加固**

`apps/api/src/routes/adminPlaces.ts`——顶部导入加 `Prisma`：

```ts
import { Prisma } from "@zhixing/db";
```

替换 POST 处理器主体（schema 校验之后）：

```ts
  // 自 places.ts 迁入:管理员建点(官方录入)。加固:父级存在性与重名显式预检——
  // @@unique([name,parentId]) 在 parentId 为 NULL 时不生效(Postgres NULL≠NULL),
  // 且 FK/unique 违约直接抛会变 500,这里收敛为 400/409 业务错误。
  app.post("/admin/places", { preHandler: requireAdmin }, async (req, reply) => {
    const body = createPlaceSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    }
    const parentId = body.data.parentId ?? null;
    if (parentId !== null) {
      const parent = await app.prisma.place.findUnique({
        where: { id: parentId }, select: { id: true },
      });
      if (!parent) return reply.code(400).send({ error: "unknown_parent" });
    }
    const dup = await app.prisma.place.findFirst({
      where: { name: body.data.name, parentId }, select: { id: true },
    });
    if (dup) return reply.code(409).send({ error: "duplicate_name" });
    try {
      const place = await app.prisma.place.create({ data: { ...body.data, parentId } });
      return reply.code(201).send(place);
    } catch (err) {
      // 预检与写入之间的并发竞态兜底
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return reply.code(409).send({ error: "duplicate_name" });
      }
      throw err;
    }
  });
```

- [ ] **Step 4: 跑测试确认通过 + 既有测试不回归**

Run: `pnpm -C apps/api exec vitest run test/adminPlaces.test.ts test/places.test.ts test/placeLinks.test.ts`
Expected: 全部 PASS（places.test.ts 的"创建并查询地点树"“非法 body”与守卫测试都不受影响）。

- [ ] **Step 5: 坐标系约定落文档**

`packages/db/prisma/schema.prisma`——Place 模型上方加注释（model Place 前一行）：

```prisma
// 地点树(PROVINCE→CITY→DISTRICT→POI)。lat/lng 全库统一 GCJ-02(火星坐标):
// iOS MapKit 大陆底图与管理端高德选点原生同系,全链路零转换;详见
// docs/superpowers/specs/2026-07-16-place-intake-design.md
model Place {
```

`CLAUDE.md`——Conventions 列表末尾加一行（英文，Claude-facing）：

```md
- All Place lat/lng are GCJ-02 (Mars coordinates) — matches MapKit's mainland-China tiles and AMap picker natively; never convert. FootprintPhoto EXIF coords stay WGS-84 (private data, not rendered on public maps).
```

- [ ] **Step 6: 提交**

```bash
git add apps/api/src/routes/adminPlaces.ts apps/api/test/adminPlaces.test.ts packages/db/prisma/schema.prisma CLAUDE.md
git commit -m "feat(api): POST /admin/places 加固——unknown_parent 400/重名 409;全库坐标声明 GCJ-02"
```

---

### Task 2: PATCH /admin/places/:id

**Files:**
- Modify: `apps/api/src/routes/adminPlaces.ts`
- Modify: `apps/api/test/adminPlaces.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 `Prisma` 导入与错误契约。
- Produces: `PATCH /admin/places/:id`（requireAdmin）。body 为 `{ name?, level?, parentId?: string|null, lat?, lng?, intro?: string|null }` 至少一个字段；成功 200 返回更新后 Place 实体（含 id/name/level/parentId/lat/lng/intro/createdAt）。错误：401 未鉴权 / 404 `not_found` / 400 `invalid_body` / 400 `unknown_parent` / 400 `cyclic_parent` / 409 `duplicate_name`。Task 3 表单的编辑保存走它。

- [ ] **Step 1: 写失败测试**

`apps/api/test/adminPlaces.test.ts` 追加：

```ts
async function seedTree(app: ReturnType<typeof testApp>) {
  const prov = await app.prisma.place.create({
    data: { name: "山东省", level: "PROVINCE", lat: 36.67, lng: 117.02 },
  });
  const city = await app.prisma.place.create({
    data: { name: "济南市", level: "CITY", parentId: prov.id, lat: 36.65, lng: 117.12 },
  });
  const poi = await app.prisma.place.create({
    data: { name: "芙蓉街", level: "POI", parentId: city.id, lat: 36.665, lng: 117.023 },
  });
  return { prov, city, poi };
}

test("PATCH /admin/places/:id 需要鉴权", async () => {
  const res = await app.inject({
    method: "PATCH", url: "/admin/places/x", payload: { name: "y" },
  });
  expect(res.statusCode).toBe(401);
});

test("PATCH：地点不存在 404", async () => {
  const res = await app.inject({
    method: "PATCH", url: "/admin/places/nope", headers: ADMIN_AUTH, payload: { name: "y" },
  });
  expect(res.statusCode).toBe(404);
  expect(res.json()).toEqual({ error: "not_found" });
});

test("PATCH：空对象 400 invalid_body", async () => {
  const { poi } = await seedTree(app);
  const res = await app.inject({
    method: "PATCH", url: `/admin/places/${poi.id}`, headers: ADMIN_AUTH, payload: {},
  });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toBe("invalid_body");
});

test("PATCH：更新名称/坐标/层级/简介并返回更新后实体，intro 传 null 清空", async () => {
  const { poi } = await seedTree(app);
  const res = await app.inject({
    method: "PATCH", url: `/admin/places/${poi.id}`, headers: ADMIN_AUTH,
    payload: { name: "芙蓉街北口", level: "DISTRICT", lat: 36.666, lng: 117.024, intro: "老街" },
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toMatchObject({
    id: poi.id, name: "芙蓉街北口", level: "DISTRICT", lat: 36.666, lng: 117.024, intro: "老街",
  });

  const cleared = await app.inject({
    method: "PATCH", url: `/admin/places/${poi.id}`, headers: ADMIN_AUTH,
    payload: { intro: null },
  });
  expect(cleared.statusCode).toBe(200);
  expect(cleared.json().intro).toBeNull();
});

test("PATCH：改父生效；父不存在 400 unknown_parent", async () => {
  const { prov, poi } = await seedTree(app);
  const ok = await app.inject({
    method: "PATCH", url: `/admin/places/${poi.id}`, headers: ADMIN_AUTH,
    payload: { parentId: prov.id },
  });
  expect(ok.statusCode).toBe(200);
  expect(ok.json().parentId).toBe(prov.id);

  const bad = await app.inject({
    method: "PATCH", url: `/admin/places/${poi.id}`, headers: ADMIN_AUTH,
    payload: { parentId: "nope" },
  });
  expect(bad.statusCode).toBe(400);
  expect(bad.json()).toEqual({ error: "unknown_parent" });
});

test("PATCH：父级设为自身或自身后代 400 cyclic_parent——树上出环会让足迹页递归 CTE 死循环", async () => {
  const { city, poi } = await seedTree(app);
  const self = await app.inject({
    method: "PATCH", url: `/admin/places/${city.id}`, headers: ADMIN_AUTH,
    payload: { parentId: city.id },
  });
  expect(self.statusCode).toBe(400);
  expect(self.json()).toEqual({ error: "cyclic_parent" });

  const descendant = await app.inject({
    method: "PATCH", url: `/admin/places/${city.id}`, headers: ADMIN_AUTH,
    payload: { parentId: poi.id },
  });
  expect(descendant.statusCode).toBe(400);
  expect(descendant.json()).toEqual({ error: "cyclic_parent" });
});

test("PATCH：改名/改父撞已有同名 409 duplicate_name", async () => {
  const { city } = await seedTree(app);
  await app.prisma.place.create({
    data: { name: "宽厚里", level: "POI", parentId: city.id, lat: 36.66, lng: 117.03 },
  });
  const other = await app.prisma.place.create({
    data: { name: "老商埠", level: "POI", parentId: city.id, lat: 36.67, lng: 117.0 },
  });
  const res = await app.inject({
    method: "PATCH", url: `/admin/places/${other.id}`, headers: ADMIN_AUTH,
    payload: { name: "宽厚里" },
  });
  expect(res.statusCode).toBe(409);
  expect(res.json()).toEqual({ error: "duplicate_name" });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/api exec vitest run test/adminPlaces.test.ts`
Expected: Task 1 的 3 个用例 PASS，新增用例全部 FAIL（PATCH 路由不存在 → Fastify 404，鉴权用例得到 404 而非 401 也算 FAIL）。

- [ ] **Step 3: 实现 PATCH**

`apps/api/src/routes/adminPlaces.ts`——schema 区追加：

```ts
const patchPlaceSchema = z
  .object({
    name: z.string().min(1),
    level: levelEnum,
    parentId: z.string().nullable(),
    lat: z.number(),
    lng: z.number(),
    intro: z.string().nullable(),
  })
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "at least one field required",
  });
```

文件底部（adminPlacesRoutes 内、links 路由之前）追加辅助函数与路由。辅助函数放在 `adminPlacesRoutes` 函数外（模块级）：

```ts
// 沿父链上溯,命中自身即成环。树深≤4,32 跳保险丝防御脏数据下的死循环。
async function reachesSelf(
  prisma: FastifyInstance["prisma"], id: string, fromParentId: string,
): Promise<boolean> {
  let cur: string | null = fromParentId;
  for (let hops = 0; cur !== null; hops++) {
    if (cur === id || hops >= 32) return true;
    const p: { parentId: string | null } | null = await prisma.place.findUnique({
      where: { id: cur }, select: { parentId: true },
    });
    if (!p) return false;
    cur = p.parentId;
  }
  return false;
}
```

路由（POST 之后）：

```ts
  // 管理员编辑地点:改名/改简介/改坐标(GCJ-02)/改父/改层级。层级搭配不强校验
  // (与 POST 一致,正确性交给管理员);改父需防树环,否则足迹页递归 CTE 死循环。
  app.patch("/admin/places/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = patchPlaceSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    }
    const current = await app.prisma.place.findUnique({ where: { id } });
    if (!current) return reply.code(404).send({ error: "not_found" });

    const nextParentId =
      body.data.parentId === undefined ? current.parentId : body.data.parentId;
    if (nextParentId !== current.parentId && nextParentId !== null) {
      const parent = await app.prisma.place.findUnique({
        where: { id: nextParentId }, select: { id: true },
      });
      if (!parent) return reply.code(400).send({ error: "unknown_parent" });
    }
    if (nextParentId !== null && nextParentId !== current.parentId) {
      if (await reachesSelf(app.prisma, id, nextParentId)) {
        return reply.code(400).send({ error: "cyclic_parent" });
      }
    }
    // 自指(parentId === id)也属成环:上面的分支在 nextParentId === id 时必然
    // 与 current.parentId 不同,reachesSelf 首跳即命中,无需单独判。
    const nextName = body.data.name ?? current.name;
    if (nextName !== current.name || nextParentId !== current.parentId) {
      const dup = await app.prisma.place.findFirst({
        where: { name: nextName, parentId: nextParentId, NOT: { id } },
        select: { id: true },
      });
      if (dup) return reply.code(409).send({ error: "duplicate_name" });
    }
    try {
      return await app.prisma.place.update({ where: { id }, data: body.data });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return reply.code(409).send({ error: "duplicate_name" });
      }
      throw err;
    }
  });
```

注意：`FastifyInstance` 已在文件顶部 `import type` 引入，`reachesSelf` 的参数类型直接复用。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm -C apps/api exec vitest run test/adminPlaces.test.ts`
Expected: 全部 PASS（3 旧 + 7 新）。

- [ ] **Step 5: 提交**

```bash
git add apps/api/src/routes/adminPlaces.ts apps/api/test/adminPlaces.test.ts
git commit -m "feat(api): PATCH /admin/places/:id——局部更新+防树环+重名 409"
```

---

### Task 3: admin 地点表单组件（手动坐标版）

**Files:**
- Create: `apps/admin/app/places/place-form.tsx`

**Interfaces:**
- Consumes: `api()`（`@/lib/api`，带 body 自动设 JSON content-type）；Task 1/2 的错误字符串 `duplicate_name`/`cyclic_parent`/`unknown_parent`（`api()` 抛 `Error("409: {\"error\":\"duplicate_name\"}")` 形态，用 `String(e).includes(...)` 判别）。
- Produces: `export type PlaceRow`、`export function PlaceForm(props)`——Task 4 的页面按此签名挂载：

```ts
export type PlaceRow = {
  id: string; name: string; level: string; parentId: string | null;
  lat: number; lng: number; intro?: string | null;
};
// props: { mode: "create" | "edit"; initial?: PlaceRow; places: PlaceRow[];
//          onDone: () => void; onCancel: () => void }
```

- [ ] **Step 1: 实现组件**

新建 `apps/admin/app/places/place-form.tsx`：

```tsx
"use client";
import { useState } from "react";
import { api } from "@/lib/api";

export type PlaceRow = {
  id: string; name: string; level: string; parentId: string | null;
  lat: number; lng: number; intro?: string | null;
};

const LEVELS = ["PROVINCE", "CITY", "DISTRICT", "POI"] as const;
export const LEVEL_LABELS: Record<string, string> = {
  PROVINCE: "省", CITY: "市", DISTRICT: "区县", POI: "点位",
};

export function PlaceForm({ mode, initial, places, onDone, onCancel }: {
  mode: "create" | "edit";
  initial?: PlaceRow;
  places: PlaceRow[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [level, setLevel] = useState(initial?.level ?? "POI");
  const [parentId, setParentId] = useState(initial?.parentId ?? "");
  const [lat, setLat] = useState(initial ? String(initial.lat) : "");
  const [lng, setLng] = useState(initial ? String(initial.lng) : "");
  const [intro, setIntro] = useState(initial?.intro ?? "");
  const [parentFilter, setParentFilter] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // 父级候选:排除 POI(叶子不能当父)与自身,按名称过滤;已选中项恒保留,否则 select
  // 显示会与实际提交值脱节。选自身后代由服务端 cyclic_parent 兜底。
  const parentOptions = places.filter(
    (p) =>
      p.level !== "POI" && p.id !== initial?.id &&
      (p.id === parentId || parentFilter.trim() === "" || p.name.includes(parentFilter.trim())),
  );
  const valid =
    name.trim() !== "" && lat !== "" && lng !== "" &&
    Number.isFinite(Number(lat)) && Number.isFinite(Number(lng));

  async function save() {
    setSaving(true); setError("");
    try {
      if (mode === "create") {
        // POST 的 intro 是 optional 非 nullable:空值必须省略字段而非传 null
        await api("/admin/places", {
          method: "POST",
          body: JSON.stringify({
            name: name.trim(), level, parentId: parentId || null,
            lat: Number(lat), lng: Number(lng),
            intro: intro.trim() === "" ? undefined : intro.trim(),
          }),
        });
      } else {
        await api(`/admin/places/${initial!.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: name.trim(), level, parentId: parentId || null,
            lat: Number(lat), lng: Number(lng),
            intro: intro.trim() === "" ? null : intro.trim(),
          }),
        });
      }
      onDone();
    } catch (e) {
      const msg = String(e);
      if (msg.includes("duplicate_name")) setError("同一父级下已有同名地点");
      else if (msg.includes("cyclic_parent")) setError("父级不能选自己或自己的后代");
      else if (msg.includes("unknown_parent")) setError("父级地点不存在，刷新后重试");
      else setError(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <fieldset style={{ margin: "12px 0", padding: 12 }}>
      <legend>{mode === "create" ? "新建地点" : `编辑：${initial?.name}`}</legend>
      {error && <p style={{ color: "red" }}>{error}</p>}
      <p>
        <input placeholder="名称" value={name} onChange={(e) => setName(e.target.value)} />{" "}
        <select value={level} onChange={(e) => setLevel(e.target.value)}>
          {LEVELS.map((l) => <option key={l} value={l}>{LEVEL_LABELS[l]}</option>)}
        </select>{" "}
        <input placeholder="过滤父级…" value={parentFilter}
          onChange={(e) => setParentFilter(e.target.value)} style={{ width: 96 }} />{" "}
        <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
          <option value="">（无父级 / 链顶）</option>
          {parentOptions.map((p) => (
            <option key={p.id} value={p.id}>{p.name}（{LEVEL_LABELS[p.level] ?? p.level}）</option>
          ))}
        </select>
      </p>
      <p>
        <input placeholder="纬度 lat（GCJ-02）" value={lat}
          onChange={(e) => setLat(e.target.value)} style={{ width: 160 }} />{" "}
        <input placeholder="经度 lng（GCJ-02）" value={lng}
          onChange={(e) => setLng(e.target.value)} style={{ width: 160 }} />
      </p>
      <p>
        <textarea placeholder="简介（可空）" value={intro}
          onChange={(e) => setIntro(e.target.value)} rows={2} cols={48} />
      </p>
      <p>
        <button onClick={save} disabled={!valid || saving}>
          {saving ? "保存中…" : "保存"}
        </button>{" "}
        <button onClick={onCancel} disabled={saving}>取消</button>
      </p>
    </fieldset>
  );
}
```

- [ ] **Step 2: 类型检查**

Run: `pnpm -C apps/admin run build`
Expected: 编译通过（组件尚未被引用，Next 仍会做全量类型检查）。

- [ ] **Step 3: 提交**

```bash
git add apps/admin/app/places/place-form.tsx
git commit -m "feat(admin): 地点表单组件——新建/编辑,坐标手输,409/成环友好文案"
```

---

### Task 4: admin 地点库页升级（列表 + 新建/编辑入口 + 父级列 + 层级筛选）

**Files:**
- Modify: `apps/admin/app/places/page.tsx`（整文件替换）

**Interfaces:**
- Consumes: Task 3 的 `PlaceForm` / `PlaceRow` / `LEVEL_LABELS`；`GET /places`（无参返回全量地点实体数组，含 parentId/intro）。
- Produces: 页面行为——「新建地点」按钮开 create 表单；每行「编辑」开 edit 表单（预填）；保存成功后重拉列表并收起表单；「父级」列显示父地点名；层级下拉筛选（纯前端过滤）。

- [ ] **Step 1: 重写页面**

`apps/admin/app/places/page.tsx` 整文件替换为：

```tsx
"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { LEVEL_LABELS, PlaceForm, type PlaceRow } from "./place-form";

const LEVELS = ["PROVINCE", "CITY", "DISTRICT", "POI"] as const;

export default function PlacesPage() {
  const [places, setPlaces] = useState<PlaceRow[]>([]);
  const [error, setError] = useState("");
  const [levelFilter, setLevelFilter] = useState("");
  const [editing, setEditing] = useState<PlaceRow | "create" | null>(null);

  const load = useCallback(() => {
    api<PlaceRow[]>("/places").then(setPlaces).catch((e) => setError(String(e)));
  }, []);
  useEffect(load, [load]);

  const nameById = useMemo(() => new Map(places.map((p) => [p.id, p.name])), [places]);
  const shown = levelFilter ? places.filter((p) => p.level === levelFilter) : places;

  return (
    <>
      <h2>地点库（{shown.length}）</h2>
      {error && <p style={{ color: "red" }}>{error}</p>}
      <p>
        <select value={levelFilter} onChange={(e) => setLevelFilter(e.target.value)}>
          <option value="">全部层级</option>
          {LEVELS.map((l) => <option key={l} value={l}>{LEVEL_LABELS[l]}</option>)}
        </select>{" "}
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

- [ ] **Step 2: 构建 + 手动冒烟**

Run: `pnpm -C apps/admin run build`
Expected: 编译通过。

冒烟（api 与 db 在跑的前提下）：`pnpm --filter @zhixing/admin dev`，浏览器开 `http://localhost:3000/places`，确认列表出父级列、筛选可用、新建/编辑表单能开合（真实创建留给 Task 6 走查）。

- [ ] **Step 3: 提交**

```bash
git add apps/admin/app/places/page.tsx
git commit -m "feat(admin): 地点库页升级——新建/编辑入口+父级列+层级筛选"
```

---

### Task 5: 高德地图选点组件 + 表单接入 + 配置文档

**Files:**
- Create: `apps/admin/app/places/amap-picker.tsx`
- Modify: `apps/admin/app/places/place-form.tsx`（插入选点组件）
- Modify: `docs/deploy.md`（追加高德 key 小节）

**Interfaces:**
- Consumes: 环境变量 `NEXT_PUBLIC_AMAP_KEY`、`NEXT_PUBLIC_AMAP_SECURITY_CODE`（高德「Web 端(JS API)」key + 2021-12 起强制的安全密钥；本地放 `apps/admin/.env.local`，已被 gitignore）。
- Produces: `export function AMapPicker({ lat, lng, onPick }: { lat: number | null; lng: number | null; onPick: (lat: number, lng: number) => void })`——未配 key 时渲染 null（表单手输兜底）。

- [ ] **Step 1: 实现选点组件**

新建 `apps/admin/app/places/amap-picker.tsx`：

```tsx
"use client";
import { useEffect, useRef, useState } from "react";

// 高德 JS API 无官方 TS 类型,按 any 使用;坐标序注意是 [lng, lat]
declare global {
  interface Window {
    AMap?: any;
    _AMapSecurityConfig?: { securityJsCode: string };
  }
}

const KEY = process.env.NEXT_PUBLIC_AMAP_KEY;
const SECURITY = process.env.NEXT_PUBLIC_AMAP_SECURITY_CODE;

let loader: Promise<any> | null = null;
function loadAMap(): Promise<any> {
  if (window.AMap) return Promise.resolve(window.AMap);
  if (!loader) {
    loader = new Promise((resolve, reject) => {
      // 安全密钥必须在脚本加载前挂到 window,否则 PlaceSearch 等服务报 INVALID_USER_SCODE
      if (SECURITY) window._AMapSecurityConfig = { securityJsCode: SECURITY };
      const s = document.createElement("script");
      s.src = `https://webapi.amap.com/maps?v=2.0&key=${KEY}&plugin=AMap.PlaceSearch`;
      s.onload = () => resolve(window.AMap);
      s.onerror = () => reject(new Error("高德地图脚本加载失败"));
      document.head.appendChild(s);
    });
  }
  return loader;
}

type Poi = { name: string; address: string; lat: number; lng: number };

export function AMapPicker({ lat, lng, onPick }: {
  lat: number | null;
  lng: number | null;
  onPick: (lat: number, lng: number) => void;
}) {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markerRef = useRef<any>(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const [keyword, setKeyword] = useState("");
  const [results, setResults] = useState<Poi[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!KEY || !mapEl.current) return;
    let disposed = false;
    loadAMap()
      .then((AMap) => {
        if (disposed || !mapEl.current) return;
        const hasInit = lat !== null && lng !== null;
        const map = new AMap.Map(mapEl.current, {
          zoom: hasInit ? 15 : 4,
          center: hasInit ? [lng, lat] : [105, 36],
        });
        mapRef.current = map;
        if (hasInit) placeMarker(lng!, lat!);
        map.on("click", (e: any) => {
          placeMarker(e.lnglat.getLng(), e.lnglat.getLat());
          onPickRef.current(e.lnglat.getLat(), e.lnglat.getLng());
        });
      })
      .catch((e) => setError(String(e)));
    return () => {
      disposed = true;
      mapRef.current?.destroy();
      mapRef.current = null;
    };
    // 仅初始化一次:lat/lng 后续变化经 placeMarker 驱动,不重建地图
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function placeMarker(lngV: number, latV: number) {
    const map = mapRef.current;
    if (!map || !window.AMap) return;
    if (!markerRef.current) {
      // 可拖拽:拖 pin 微调坐标(spec"点击/拖 pin"),dragend 回填
      const marker = new window.AMap.Marker({ position: [lngV, latV], draggable: true });
      marker.on("dragend", () => {
        const pos = marker.getPosition();
        onPickRef.current(pos.getLat(), pos.getLng());
      });
      markerRef.current = marker;
      map.add(marker);
    } else {
      markerRef.current.setPosition([lngV, latV]);
    }
  }

  function search() {
    if (!window.AMap || !keyword.trim()) return;
    new window.AMap.PlaceSearch({ pageSize: 5 }).search(
      keyword.trim(),
      (status: string, result: any) => {
        if (status !== "complete") {
          setResults([]);
          setError(status === "no_data" ? "没有搜到结果" : `搜索失败：${status}`);
          return;
        }
        setError("");
        setResults(
          result.poiList.pois.map((p: any) => ({
            name: p.name, address: p.address || "",
            lat: p.location.lat, lng: p.location.lng,
          })),
        );
      },
    );
  }

  function pickPoi(p: Poi) {
    mapRef.current?.setZoomAndCenter(16, [p.lng, p.lat]);
    placeMarker(p.lng, p.lat);
    onPickRef.current(p.lat, p.lng);
    setResults([]);
  }

  if (!KEY) return null; // 未配 key:表单退化为手动输入经纬度

  return (
    <div style={{ margin: "8px 0" }}>
      <p>
        <input placeholder="搜地名定位（高德）" value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); search(); } }}
          size={32} />{" "}
        <button type="button" onClick={search}>搜索</button>
        {error && <span style={{ color: "red", marginLeft: 8 }}>{error}</span>}
      </p>
      {results.length > 0 && (
        <ul style={{ margin: "4px 0", paddingLeft: 20 }}>
          {results.map((p, i) => (
            <li key={i}>
              <button type="button" onClick={() => pickPoi(p)}
                style={{ border: "none", background: "none", color: "#06c", cursor: "pointer", padding: 0 }}>
                {p.name}
              </button>{" "}
              <small>{p.address}</small>
            </li>
          ))}
        </ul>
      )}
      <div ref={mapEl} style={{ width: "100%", maxWidth: 640, height: 320, border: "1px solid #ccc" }} />
      <p><small>点击地图或选择搜索结果，坐标（GCJ-02）自动回填下方输入框。</small></p>
    </div>
  );
}
```

- [ ] **Step 2: 接入表单**

`apps/admin/app/places/place-form.tsx`——顶部加导入：

```tsx
import { AMapPicker } from "./amap-picker";
```

在坐标输入的 `<p>` 之前插入：

```tsx
      <AMapPicker
        lat={lat === "" || !Number.isFinite(Number(lat)) ? null : Number(lat)}
        lng={lng === "" || !Number.isFinite(Number(lng)) ? null : Number(lng)}
        onPick={(la, ln) => { setLat(la.toFixed(6)); setLng(ln.toFixed(6)); }}
      />
```

- [ ] **Step 3: 构建**

Run: `pnpm -C apps/admin run build`
Expected: 编译通过（未配 key 的构建也必须通过——KEY 判空在运行时）。

- [ ] **Step 4: 配置文档**

`docs/deploy.md`——admin 相关段落之后追加小节（找不到合适锚点就加在环境变量说明附近）：

```md
### 管理端高德选点（可选）

admin 地点表单的地图选点读 `NEXT_PUBLIC_AMAP_KEY` 与 `NEXT_PUBLIC_AMAP_SECURITY_CODE`
（高德开放平台「Web 端(JS API)」key + 安全密钥，域名白名单填 admin.example.com 与 localhost:3000）。
Next.js 的 NEXT_PUBLIC_ 变量在构建期内联：本地开发写 `apps/admin/.env.local`；
生产镜像构建需经 build args 注入（暂未接线——**未配 key 时表单自动退化为手动输入经纬度，
不阻塞部署**，接线等确有生产建点需求再做）。
```

- [ ] **Step 5: 提交**

```bash
git add apps/admin/app/places/amap-picker.tsx apps/admin/app/places/place-form.tsx docs/deploy.md
git commit -m "feat(admin): 高德地图选点——搜索定位/点击取点,未配 key 退化手输"
```

---

### Task 6: 端到端走查 + 全量回归

**Files:**
- 无代码变更（验证任务；发现问题则回相应 Task 修复后重走）

**Interfaces:**
- Consumes: Task 1-5 全部交付物；dev 环境 ADMIN_TOKEN=`dev-admin-token`。
- Produces: 走查通过的结论与截图；全量测试绿。

- [ ] **Step 1: 起环境**

```bash
open -a Docker   # 若未在跑
pnpm db:up
pnpm --filter @zhixing/api dev &     # :8787
pnpm --filter @zhixing/admin dev &   # :3000（NEXT_PUBLIC_API_URL 默认指 :8787）
```

- [ ] **Step 2: 浏览器走查（Playwright MCP 或真人）**

1. 开 `http://localhost:3000`，顶部 token 栏填 `dev-admin-token` 保存。
2. 进「地点库」：确认父级列与层级筛选正常。
3. 新建 `走查-测试省`（层级=省，无父级，坐标手输 34 / 108）→ 保存 → 列表出现。
4. 新建 `走查-子点`（层级=点位，父级=走查-测试省，坐标 34.1 / 108.1）→ 保存 → 父级列显示「走查-测试省」。
5. 再建一次同名 `走查-子点` 同父级 → 表单显示「同一父级下已有同名地点」。
6. 编辑 `走查-子点` 改名 `走查-子点2` 改坐标 → 保存 → 列表更新。
7. 层级筛选切「点位」→ 只剩点位行。截图存档。
8. （仅当已配 `apps/admin/.env.local` 的高德 key）表单里搜「什刹海」→ 选结果 → 地图落 pin、坐标自动回填；点击地图他处 → 坐标更新。

- [ ] **Step 3: 清理走查数据**

```bash
docker exec zhixing-db-1 psql -U zhixing -d zhixing \
  -c "DELETE FROM \"Place\" WHERE name LIKE '走查-%';"
```

Expected: `DELETE 2`（父删子的 parentId 置 NULL 不阻删；走查地点未挂卡片/足迹）。

- [ ] **Step 4: 全量回归**

```bash
pnpm -C apps/api exec vitest run
pnpm -C apps/admin run build
```

Expected: api 全绿（167 + 本计划新增 10 个）；admin 构建通过。

- [ ] **Step 5: 收尾提交（如走查产生修复）**

修复类改动按所属 Task 的 commit 风格单独提交；无修复则本 Task 无提交。
