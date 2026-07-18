# 管理端点位自动挂省市链 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 管理端新建点位时,从高德搜索/地图点选自动识别所属省市,保存时服务端按名幂等 find-or-create 省市节点并逐级挂链,管理员不再手工维护省市树。

**Architecture:** 前端 `AMapPicker` 打开 `extensions: "all"` 拿到 POI 自带的 `pname`/`cityname`,地图点选与拖 pin 走 `AMap.Geocoder` 逆地理编码兜底,归一化为 `AdminRegion` 回传表单;表单在"新建 + 未手选父级 + 层级为区县/点位"时把省市链作为 `ancestors` 参数随 `POST /admin/places` 提交;服务端逐级 find-or-create(只复用不修改既有节点),解析出 parentId 后走既有的重名预检与创建路径。直辖市/特区(市名=省名或逆编码 city 为空)收敛为单个省级链顶节点,与库内既有形态(如北京市 `level: PROVINCE`)一致。

**Tech Stack:** Fastify 5 + zod + Prisma(apps/api),Next.js 15 client component + 高德 JS API 2.0(apps/admin),vitest 集成测试(真 Postgres)。

## Global Constraints

- ESM + TS strict + NodeNext:相对导入必须带 `.js` 后缀(仅 api 侧;admin 用 Next 路径别名)。
- 错误形状统一 `{ error: string, detail?: any }`;body 校验一律 zod,失败 400 `invalid_body`。
- 注释、文档、commit message 用中文;conventional commits(如 `feat(api): ...`)。
- 坐标全链路 GCJ-02,高德返回的就是 GCJ-02,零转换。
- 测试跑真库:先 `pnpm db:up`(Docker 需在跑);若首次或改过 schema 先 `pnpm -C packages/db push:test`。本计划不加表,无需动 TRUNCATE 清单。
- 先建分支再动代码:`git checkout -b feat/admin-place-ancestors`;push/合并留给用户。
- 服务端对既有省市节点**只复用、绝不修改**(level/坐标原样保留);新建祖先节点坐标缺省回落到该点位坐标(在正确行政区内,可后续在管理端修正)。

---

### Task 1: API — `POST /admin/places` 支持 `ancestors` 祖先链

**Files:**
- Modify: `apps/api/src/routes/adminPlaces.ts`(schema 区 + POST 路由)
- Test: `apps/api/test/adminPlaces.test.ts`(文件末尾追加)

**Interfaces:**
- Consumes: 既有 `createPlaceSchema` / `requireAdmin` / Prisma `name_parentId` 复合唯一(schema.prisma `@@unique([name, parentId])`)。
- Produces: `POST /admin/places` 新可选参数 `ancestors: Array<{ name: string; level: "PROVINCE" | "CITY"; lat?: number; lng?: number }>`(链顶在前,1–2 个;与非空 `parentId` 互斥)。新错误码:400 `conflicting_parent`(ancestors 与 parentId 同给)、400 `invalid_ancestors`(首个非 PROVINCE / 第二个非 CITY / 两级同名)。成功仍 201 返回创建的 place(parentId 已解析)。Task 3 的前端按此契约提交。

- [x] **Step 0: 建分支**

```bash
git checkout -b feat/admin-place-ancestors
```

- [x] **Step 1: 写失败测试**

在 `apps/api/test/adminPlaces.test.ts` 末尾追加(`seedTree` 已在该文件中,含 山东省→济南市→芙蓉街 三节点):

```ts
test("POST /admin/places + ancestors：全新省市链自动创建并逐级挂接；祖先缺坐标回落点位坐标", async () => {
  const res = await app.inject({
    method: "POST", url: "/admin/places", headers: ADMIN_AUTH,
    payload: {
      name: "芙蓉街", level: "POI", lat: 36.665, lng: 117.023,
      ancestors: [
        { name: "山东省", level: "PROVINCE", lat: 36.67, lng: 117.02 },
        { name: "济南市", level: "CITY" },
      ],
    },
  });
  expect(res.statusCode).toBe(201);
  const prov = await app.prisma.place.findFirstOrThrow({ where: { name: "山东省" } });
  const city = await app.prisma.place.findFirstOrThrow({ where: { name: "济南市" } });
  expect(prov).toMatchObject({ level: "PROVINCE", parentId: null, lat: 36.67, lng: 117.02 });
  expect(city).toMatchObject({ level: "CITY", parentId: prov.id, lat: 36.665, lng: 117.023 });
  expect(res.json()).toMatchObject({ name: "芙蓉街", parentId: city.id });
  expect(await app.prisma.place.count()).toBe(3);
});

test("POST + ancestors：已有节点只复用不修改，level/坐标原样保留", async () => {
  const { prov, city } = await seedTree(app);
  const res = await app.inject({
    method: "POST", url: "/admin/places", headers: ADMIN_AUTH,
    payload: {
      name: "宽厚里", level: "POI", lat: 36.66, lng: 117.03,
      ancestors: [
        { name: "山东省", level: "PROVINCE", lat: 1, lng: 2 },
        { name: "济南市", level: "CITY", lat: 3, lng: 4 },
      ],
    },
  });
  expect(res.statusCode).toBe(201);
  expect(res.json().parentId).toBe(city.id);
  const provAfter = await app.prisma.place.findUniqueOrThrow({ where: { id: prov.id } });
  const cityAfter = await app.prisma.place.findUniqueOrThrow({ where: { id: city.id } });
  expect(provAfter).toMatchObject({ level: "PROVINCE", lat: 36.67, lng: 117.02 });
  expect(cityAfter).toMatchObject({ level: "CITY", lat: 36.65, lng: 117.12 });
  expect(await app.prisma.place.count()).toBe(4); // seedTree 3 个 + 新点位
});

test("POST + ancestors：直辖市单省级节点成链顶", async () => {
  const res = await app.inject({
    method: "POST", url: "/admin/places", headers: ADMIN_AUTH,
    payload: {
      name: "什刹海", level: "POI", lat: 39.9403, lng: 116.383,
      ancestors: [{ name: "北京市", level: "PROVINCE" }],
    },
  });
  expect(res.statusCode).toBe(201);
  const bj = await app.prisma.place.findFirstOrThrow({ where: { name: "北京市" } });
  expect(bj).toMatchObject({ level: "PROVINCE", parentId: null });
  expect(res.json().parentId).toBe(bj.id);
});

test("POST + ancestors：与非空 parentId 同给 400 conflicting_parent，不产生写入", async () => {
  const { city } = await seedTree(app);
  const res = await app.inject({
    method: "POST", url: "/admin/places", headers: ADMIN_AUTH,
    payload: {
      name: "宽厚里", level: "POI", lat: 36.66, lng: 117.03, parentId: city.id,
      ancestors: [{ name: "山东省", level: "PROVINCE" }],
    },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({ error: "conflicting_parent" });
  expect(await app.prisma.place.count()).toBe(3);
});

test("POST + ancestors：链序非法/两级同名 400 invalid_ancestors；空数组 400 invalid_body", async () => {
  const cityFirst = await app.inject({
    method: "POST", url: "/admin/places", headers: ADMIN_AUTH,
    payload: {
      name: "点", level: "POI", lat: 1, lng: 2,
      ancestors: [{ name: "济南市", level: "CITY" }],
    },
  });
  expect(cityFirst.statusCode).toBe(400);
  expect(cityFirst.json()).toEqual({ error: "invalid_ancestors" });

  const sameName = await app.inject({
    method: "POST", url: "/admin/places", headers: ADMIN_AUTH,
    payload: {
      name: "点", level: "POI", lat: 1, lng: 2,
      ancestors: [
        { name: "北京市", level: "PROVINCE" },
        { name: "北京市", level: "CITY" },
      ],
    },
  });
  expect(sameName.statusCode).toBe(400);
  expect(sameName.json()).toEqual({ error: "invalid_ancestors" });

  const empty = await app.inject({
    method: "POST", url: "/admin/places", headers: ADMIN_AUTH,
    payload: { name: "点", level: "POI", lat: 1, lng: 2, ancestors: [] },
  });
  expect(empty.statusCode).toBe(400);
  expect(empty.json().error).toBe("invalid_body");
  expect(await app.prisma.place.count()).toBe(0);
});

test("POST + ancestors：解析后同父重名仍 409，省市不重复建", async () => {
  await seedTree(app); // 济南市下已有 芙蓉街
  const res = await app.inject({
    method: "POST", url: "/admin/places", headers: ADMIN_AUTH,
    payload: {
      name: "芙蓉街", level: "POI", lat: 36.665, lng: 117.023,
      ancestors: [
        { name: "山东省", level: "PROVINCE" },
        { name: "济南市", level: "CITY" },
      ],
    },
  });
  expect(res.statusCode).toBe(409);
  expect(res.json()).toEqual({ error: "duplicate_name" });
  expect(await app.prisma.place.count()).toBe(3);
});
```

- [x] **Step 2: 跑测试确认失败**

Run: `pnpm -C apps/api exec vitest run test/adminPlaces.test.ts`
Expected: 新增 6 条 FAIL(ancestors 被 zod strip 掉 → 表现为 400/写入数错误等),旧用例全 PASS。

- [x] **Step 3: 实现**

`apps/api/src/routes/adminPlaces.ts`:

3a. 在 `createPlaceSchema` 前加祖先 schema,并给 `createPlaceSchema` 增加 `ancestors` 字段:

```ts
const ancestorSchema = z.object({
  name: z.string().trim().min(1),
  level: z.enum(["PROVINCE", "CITY"]),
  lat: z.number().optional(),
  lng: z.number().optional(),
});

const createPlaceSchema = z.object({
  name: z.string().min(1),
  level: levelEnum,
  parentId: z.string().nullish(),
  ancestors: z.array(ancestorSchema).min(1).max(2).optional(),
  lat: z.number(),
  lng: z.number(),
  intro: z.string().optional(),
});
```

3b. 在 `reachesSelf` 之后加解析函数:

```ts
// 祖先链 find-or-create:链顶在前([省] 或 [省,市];直辖市/特区只传单个省级节点)。
// 只复用不修改——同名命中时不动既有节点的 level/坐标;新建时坐标缺省回落到子点位
// 坐标(必在正确行政区内,后续可在管理端修正)。并发竞态:非链顶撞 P2002 用
// name_parentId 回查;链顶无 unique(NULL≠NULL)不加锁,窄竞态下的重复链顶可改父收敛。
async function resolveAncestors(
  prisma: FastifyInstance["prisma"],
  ancestors: z.infer<typeof ancestorSchema>[],
  fallback: { lat: number; lng: number },
): Promise<string> {
  let parentId: string | null = null;
  for (const a of ancestors) {
    const found = await prisma.place.findFirst({
      where: { name: a.name, parentId }, select: { id: true },
    });
    if (found) { parentId = found.id; continue; }
    try {
      const created = await prisma.place.create({
        data: {
          name: a.name, level: a.level, parentId,
          lat: a.lat ?? fallback.lat, lng: a.lng ?? fallback.lng,
        },
        select: { id: true },
      });
      parentId = created.id;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002" && parentId !== null
      ) {
        const raced = await prisma.place.findUnique({
          where: { name_parentId: { name: a.name, parentId } }, select: { id: true },
        });
        if (raced) { parentId = raced.id; continue; }
      }
      throw err;
    }
  }
  // zod min(1) 保证至少一跳,循环后必非 null
  return parentId!;
}
```

3c. 改写 POST 路由主体(替换原 `const parentId = body.data.parentId ?? null;` 到 create 的整段;dup 预检、create、P2002 兜底保持原样,仅 parentId 来源变化)。注意:`ancestors` 必须从 create 数据中剥离,否则会被 spread 进 prisma:

```ts
  app.post("/admin/places", { preHandler: requireAdmin }, async (req, reply) => {
    const body = createPlaceSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    }
    const { ancestors, ...data } = body.data;
    let parentId = data.parentId ?? null;
    if (ancestors) {
      // 两种父级来源互斥,避免"听谁的"歧义
      if (parentId !== null) return reply.code(400).send({ error: "conflicting_parent" });
      if (
        ancestors[0].level !== "PROVINCE" ||
        (ancestors.length === 2 &&
          (ancestors[1].level !== "CITY" || ancestors[1].name === ancestors[0].name))
      ) {
        return reply.code(400).send({ error: "invalid_ancestors" });
      }
      // 后续重名 409 时已建的省市节点会留下——本就是合法行政区节点,重试直接复用
      parentId = await resolveAncestors(app.prisma, ancestors, {
        lat: data.lat, lng: data.lng,
      });
    } else if (parentId !== null) {
      const parent = await app.prisma.place.findUnique({
        where: { id: parentId }, select: { id: true },
      });
      if (!parent) return reply.code(400).send({ error: "unknown_parent" });
    }
    const dup = await app.prisma.place.findFirst({
      where: { name: data.name, parentId }, select: { id: true },
    });
    if (dup) return reply.code(409).send({ error: "duplicate_name" });
    try {
      const place = await app.prisma.place.create({ data: { ...data, parentId } });
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

路由顶部原有的迁入说明注释保留,补一句 ancestors 语义即可。

- [x] **Step 4: 跑测试确认通过**

Run: `pnpm -C apps/api exec vitest run test/adminPlaces.test.ts`
Expected: 全 PASS(旧 9 + 新 6)。

- [x] **Step 5: 全量 api 套件**

Run: `pnpm -C apps/api exec vitest run`
Expected: 全 PASS。

- [x] **Step 6: Commit**

```bash
git add apps/api/src/routes/adminPlaces.ts apps/api/test/adminPlaces.test.ts
git commit -m "feat(api): 建点支持 ancestors 祖先链——省市按名幂等 find-or-create 逐级挂接"
```

---

### Task 2: AMapPicker — 搜索/点选感知省市并回传

**Files:**
- Modify: `apps/admin/app/places/amap-picker.tsx`

**Interfaces:**
- Consumes: 高德 JS API 2.0 `AMap.PlaceSearch`(`extensions: "all"` 后 poi 带 `pname`/`cityname`)、`AMap.Geocoder.getAddress` → `regeocode.addressComponent.{province,city}`。
- Produces: `export type AdminRegion = { provinceName: string; cityName: string | null }`(cityName 为 null 表示直辖市/特区/省直辖,链上只有省级节点);`AMapPicker` 新可选 prop `onRegion?: (region: AdminRegion | null) => void`——POI 选中同步触发,地图点击/拖 pin 经逆地理编码异步触发,解析失败回传 null。Task 3 消费。

- [x] **Step 1: 修改 amap-picker.tsx**

1a. 脚本 URL 加载 Geocoder 插件(第 23 行):

```ts
      s.src = `https://webapi.amap.com/maps?v=2.0&key=${KEY}&plugin=AMap.PlaceSearch,AMap.Geocoder`;
```

1b. `Poi` 类型区(替换第 32 行)加导出类型与归一化助手:

```ts
type Poi = { name: string; address: string; lat: number; lng: number; region: AdminRegion | null };

/** cityName 为 null:直辖市/特区(市名=省名)或省直辖(市名为空),链上只有省级节点 */
export type AdminRegion = { provinceName: string; cityName: string | null };

// 高德空字段可能是 "" 或 [],统一收敛成 trim 后字符串
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function toRegion(provinceRaw: unknown, cityRaw: unknown): AdminRegion | null {
  const province = str(provinceRaw);
  if (!province) return null;
  const city = str(cityRaw);
  return { provinceName: province, cityName: city && city !== province ? city : null };
}
```

1c. Props 增加 `onRegion`,并与 `onPickRef` 同法镜像成 ref(组件签名与 ref 区):

```ts
export function AMapPicker({ lat, lng, onPick, onRegion }: {
  lat: number | null;
  lng: number | null;
  onPick: (lat: number, lng: number) => void;
  onRegion?: (region: AdminRegion | null) => void;
}) {
```

```ts
  const onRegionRef = useRef(onRegion);
  onRegionRef.current = onRegion;
  const geocoderRef = useRef<any>(null);
```

1d. 在 `placeMarker` 函数后加逆地理编码(未传 onRegion 时零调用,edit 模式不发请求):

```ts
  // 地图点选/拖 pin 没有 POI 语境,用逆地理编码反查省市;失败回传 null 让表单降级手选
  function resolveRegion(lngV: number, latV: number) {
    if (!onRegionRef.current || !window.AMap?.Geocoder) return;
    geocoderRef.current ??= new window.AMap.Geocoder();
    geocoderRef.current.getAddress([lngV, latV], (status: string, result: any) => {
      if (status !== "complete" || !result?.regeocode) {
        onRegionRef.current?.(null);
        return;
      }
      const comp = result.regeocode.addressComponent ?? {};
      onRegionRef.current?.(toRegion(comp.province, comp.city));
    });
  }
```

1e. 地图 click 处理(第 65–68 行)与 marker dragend(第 103–106 行)各补一行 `resolveRegion`:

```ts
        map.on("click", (e: any) => {
          placeMarker(e.lnglat.getLng(), e.lnglat.getLat());
          onPickRef.current(e.lnglat.getLat(), e.lnglat.getLng());
          resolveRegion(e.lnglat.getLng(), e.lnglat.getLat());
        });
```

```ts
      marker.on("dragend", () => {
        const pos = marker.getPosition();
        onPickRef.current(pos.getLat(), pos.getLng());
        resolveRegion(pos.getLng(), pos.getLat());
      });
```

1f. `search()`:PlaceSearch 开 `extensions`,结果映射带 region(替换第 116 与 126–129 行):

```ts
    new window.AMap.PlaceSearch({ pageSize: 5, extensions: "all" }).search(
```

```ts
        setResults(
          result.poiList.pois.map((p: any) => ({
            name: p.name, address: p.address || "",
            lat: p.location.lat, lng: p.location.lng,
            region: toRegion(p.pname, p.cityname),
          })),
        );
```

1g. `pickPoi`(第 135 行起)回传 region:

```ts
  function pickPoi(p: Poi) {
    mapRef.current?.setZoomAndCenter(16, [p.lng, p.lat]);
    placeMarker(p.lng, p.lat);
    onPickRef.current(p.lat, p.lng);
    onRegionRef.current?.(p.region);
    setResults([]);
  }
```

手输坐标跟随 effect **不**触发 resolveRegion:逐字输入的中间坐标反查无意义,该路径维持手选父级。

- [x] **Step 2: 构建验证**

Run: `pnpm -C apps/admin exec next build`
Expected: 编译通过,无类型错误。

- [x] **Step 3: Commit**

```bash
git add apps/admin/app/places/amap-picker.tsx
git commit -m "feat(admin): 高德选点感知省市——POI 自带字段+逆地理编码兜底回传 AdminRegion"
```

---

### Task 3: PlaceForm — 自动挂链提交 ancestors

**Files:**
- Modify: `apps/admin/app/places/place-form.tsx`

**Interfaces:**
- Consumes: Task 1 的 `ancestors` 参数契约;Task 2 的 `AdminRegion` / `onRegion`。
- Produces: 新建表单的自动挂链交互(提示行 + "不挂链"退出 + 手选父级覆盖)。

- [x] **Step 1: 修改 place-form.tsx**

1a. 导入类型(第 4 行):

```ts
import { AMapPicker, type AdminRegion } from "./amap-picker";
```

1b. 状态区(第 31 行后)加 region,并推导链名(仅新建、未手选父级、层级为区县/点位时启用;省市本身就是链,不套链):

```ts
  const [region, setRegion] = useState<AdminRegion | null>(null);

  // 自动挂链仅在:新建 + 未手动选父级 + 层级为区县/点位 时启用
  const chainNames =
    mode === "create" && region !== null && parentId === "" &&
    (level === "POI" || level === "DISTRICT")
      ? region.cityName === null
        ? [region.provinceName]
        : [region.provinceName, region.cityName]
      : null;
```

1c. `save()` 的 create 分支(第 48–56 行)按链提交(链首省、链次市;启用挂链时不传 parentId):

```ts
      if (mode === "create") {
        // POST 的 intro 是 optional 非 nullable:空值必须省略字段而非传 null
        const ancestors = chainNames?.map((n, i) => ({
          name: n, level: i === 0 ? "PROVINCE" : "CITY",
        }));
        await api("/admin/places", {
          method: "POST",
          body: JSON.stringify({
            name: name.trim(), level,
            ...(ancestors ? { ancestors } : { parentId: parentId || null }),
            lat: Number(lat), lng: Number(lng),
            intro: intro.trim() === "" ? undefined : intro.trim(),
          }),
        });
      } else {
```

1d. 错误映射(第 70–73 行区域)补两条:

```ts
      else if (msg.includes("conflicting_parent")) setError("父级与自动挂链冲突，请重试");
      else if (msg.includes("invalid_ancestors")) setError("自动挂链数据异常，请手动选择父级");
```

1e. `AMapPicker` 处(第 97 行)传入 onRegion(仅新建模式接收;编辑模式不传,picker 零逆编码调用):

```tsx
      <AMapPicker
        lat={lat === "" || !Number.isFinite(Number(lat)) ? null : Number(lat)}
        lng={lng === "" || !Number.isFinite(Number(lng)) ? null : Number(lng)}
        onPick={(la, ln) => { setLat(la.toFixed(6)); setLng(ln.toFixed(6)); }}
        onRegion={mode === "create" ? setRegion : undefined}
      />
```

1f. 提示行:AMapPicker 与坐标输入行之间插入:

```tsx
      {chainNames && (
        <p style={{ color: "#087" }}>
          将自动挂入：{chainNames.join(" → ")} → 本点位（省市不存在则自动创建；改选父级可覆盖）{" "}
          <button type="button" onClick={() => setRegion(null)}>不挂链</button>
        </p>
      )}
```

- [x] **Step 2: 构建验证**

Run: `pnpm -C apps/admin exec next build`
Expected: 编译通过。

- [x] **Step 3: Commit**

```bash
git add apps/admin/app/places/place-form.tsx
git commit -m "feat(admin): 新建点位自动挂省市链——识别提示/不挂链退出/手选父级覆盖"
```

---

### Task 4: 端到端冒烟 + 运营文档

**Files:**
- Modify: `docs/content-ops.md`(手工建点 API 段落,先 `rg -n "admin/places" docs/content-ops.md` 定位)

**Interfaces:**
- Consumes: Task 1–3 全部产出;`.claude/launch.json` 预览服务(api :8799 dev auth / admin :3000 → :8799)。
- Produces: 冒烟通过的完整功能 + 更新后的运营手册。

- [x] **Step 1: API 端到端冒烟(真服务器,非 inject)**

启动预览 api(:8799,dev auth),然后:

```bash
# 1) 管理员 token 就绪后,带 ancestors 建点(省市均不存在)
curl -s -X POST http://localhost:8799/admin/places \
  -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"name":"趵突泉","level":"POI","lat":36.6614,"lng":117.0125,
       "ancestors":[{"name":"山东省","level":"PROVINCE"},{"name":"济南市","level":"CITY"}]}'
# 2) 复跑同市另一点位,确认省市复用不重复建
curl -s -X POST http://localhost:8799/admin/places \
  -H "authorization: Bearer $ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"name":"黑虎泉","level":"POI","lat":36.6607,"lng":117.0317,
       "ancestors":[{"name":"山东省","level":"PROVINCE"},{"name":"济南市","level":"CITY"}]}'
# 3) GET /places 检查树:山东省(链顶) ← 济南市 ← 两个 POI,且山东省/济南市各仅 1 个
curl -s http://localhost:8799/places | python3 -m json.tool
```

Expected: 两次 201;GET 树形关系正确,无重复省市节点。

- [x] **Step 2: 管理端 UI 走查**

起 admin 预览(:3000),浏览器走查:新建地点 → 搜"趵突泉"→ 选中 → 出现"将自动挂入:山东省 → 济南市 → 本点位"→ 保存后列表中父级正确;再验证"不挂链"按钮与手选父级覆盖、地图点选路径的逆编码提示。若浏览器驱动不可用,交用户人工走查并等确认。

- [x] **Step 3: 更新 docs/content-ops.md**

在手工建点 API 段落补 `ancestors` 用法(与冒烟 curl 同形),说明三条语义:链顶在前([省] 或 [省,市],直辖市/特区只传单个省级节点)、与 parentId 互斥、既有节点只复用不修改且新建祖先坐标缺省回落点位坐标。

- [x] **Step 4: 全量回归**

Run: `pnpm -C apps/api exec vitest run`
Expected: 全 PASS。

- [x] **Step 5: Commit**

```bash
git add docs/content-ops.md docs/superpowers/plans/2026-07-18-admin-place-ancestors.md
git commit -m "docs(ops): 手工建点补 ancestors 自动挂链用法；勾选实施计划"
```

---

## 评审修订（2026-07-18 多代理评审后追加）

10 视角评审 + 3 项裁决后落实的修订（详见 commit 记录）：

- **补挂收编**：resolveAncestors 增加遗留链顶收编分支——市级跳在省下找不到时，按
  `createdAt+id` 取最老的同名无父级节点，改 parentId+level 收编（与 import-regions
  补挂同语义），不再创建重复市；reachesSelf 防跨请求互挂成环；收编写入在 P2002
  兜底之内，竞态收敛为复用。链顶跳保持只复用不升级（import-places 重跑职责）。
- **创建必须带坐标**：新建省/市祖先缺 lat/lng 返回 400 `ancestor_coords_required`
  ——iOS nearestPin 按 距离/半径 打分（市 30km/点位 3km），市落在点位坐标上会永远
  抢赢点位，静默毒化相册导入与"使用当前位置"。前端经 AMap.DistrictSearch 异步补齐
  行政中心坐标。
- **name 统一 trim**：create/patch 的 name 与 ancestors 一致 trim，空白差异不再
  绕过重名预检。
- **前端状态机**：区域解析加序号（乱序/迟到的逆编码按序丢弃，pickPoi/手输坐标接管
  均作废在途解析）；"不挂链"改为显式 chainOff 粘滞位（亲手选"链顶"同置位，恢复
  按钮显式复位）；手输坐标使 region 失效；层级选"市"时挂 [省] 链（防重复链顶市）；
  提示尾缀随层级；Geocoder 缺失显式回传 null。
- **裁定不改**：命名业务错误码保留（unknown_parent/cyclic_parent 先例 + 独立 UI
  文案）；P2002 内层回查保留（透明化解竞态优于误导性 409）；非 201 留下已建/已收编
  省市（修复性写入，注释与文档已声明）；省直辖县逆编码路径拍平为 [省]（已知取舍，
  POI 搜索路径不受影响）。
- **查漏轮补修**:目标收编——建"市"撞同名遗留链顶时收编为目标本身并应用本次提交
  (祖先跳之外的最后一个重复市口子);onRegion 回调附带来源坐标,表单对不上当前
  坐标基准即丢弃(关死 600ms 防抖窗内的旧 region 复活);resolveAncestors 相关
  变量显式类型标注,消除 TS7022 循环推断(vitest 不查类型,tsc --noEmit 把关)。
