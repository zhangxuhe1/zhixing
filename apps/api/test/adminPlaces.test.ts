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

test("POST /admin/places + ancestors：全新省市链自动创建并逐级挂接（创建必须带坐标）", async () => {
  const res = await app.inject({
    method: "POST", url: "/admin/places", headers: ADMIN_AUTH,
    payload: {
      name: "芙蓉街", level: "POI", lat: 36.665, lng: 117.023,
      ancestors: [
        { name: "山东省", level: "PROVINCE", lat: 36.67, lng: 117.02 },
        { name: "济南市", level: "CITY", lat: 36.65, lng: 117.12 },
      ],
    },
  });
  expect(res.statusCode).toBe(201);
  const prov = await app.prisma.place.findFirstOrThrow({ where: { name: "山东省" } });
  const city = await app.prisma.place.findFirstOrThrow({ where: { name: "济南市" } });
  expect(prov).toMatchObject({ level: "PROVINCE", parentId: null, lat: 36.67, lng: 117.02 });
  expect(city).toMatchObject({ level: "CITY", parentId: prov.id, lat: 36.65, lng: 117.12 });
  expect(res.json()).toMatchObject({ name: "芙蓉街", parentId: city.id });
  expect(await app.prisma.place.count()).toBe(3);
});

test("POST + ancestors：创建新祖先缺坐标（含只带半边）400 ancestor_coords_required——防 iOS 匹配半径被点位坐标毒化", async () => {
  const missing = await app.inject({
    method: "POST", url: "/admin/places", headers: ADMIN_AUTH,
    payload: {
      name: "芙蓉街", level: "POI", lat: 36.665, lng: 117.023,
      ancestors: [{ name: "山东省", level: "PROVINCE" }],
    },
  });
  expect(missing.statusCode).toBe(400);
  expect(missing.json()).toEqual({
    error: "ancestor_coords_required", detail: { name: "山东省" },
  });
  expect(await app.prisma.place.count()).toBe(0);

  const halfCoords = await app.inject({
    method: "POST", url: "/admin/places", headers: ADMIN_AUTH,
    payload: {
      name: "芙蓉街", level: "POI", lat: 36.665, lng: 117.023,
      ancestors: [{ name: "山东省", level: "PROVINCE", lat: 36.67 }],
    },
  });
  expect(halfCoords.statusCode).toBe(400);
  expect(halfCoords.json().error).toBe("ancestor_coords_required");
  expect(await app.prisma.place.count()).toBe(0);
});

test("POST + ancestors：复用已有节点时坐标可省略", async () => {
  await seedTree(app);
  const res = await app.inject({
    method: "POST", url: "/admin/places", headers: ADMIN_AUTH,
    payload: {
      name: "宽厚里", level: "POI", lat: 36.66, lng: 117.03,
      ancestors: [
        { name: "山东省", level: "PROVINCE" },
        { name: "济南市", level: "CITY" },
      ],
    },
  });
  expect(res.statusCode).toBe(201);
  expect(await app.prisma.place.count()).toBe(4);
});

test("补挂：同名遗留链顶市被收编到省下（不建重复市，坐标不动，level 归一）", async () => {
  const legacy = await app.prisma.place.create({
    data: { name: "济南市", level: "CITY", lat: 36.65, lng: 117.12 },
  });
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
  const cities = await app.prisma.place.findMany({ where: { name: "济南市" } });
  expect(cities).toHaveLength(1);
  expect(cities[0]).toMatchObject({
    id: legacy.id, parentId: prov.id, level: "CITY", lat: 36.65, lng: 117.12,
  });
  expect(res.json().parentId).toBe(legacy.id);
  expect(await app.prisma.place.count()).toBe(3);
});

test("补挂：省已存在时同样收编；遗留链顶 level 异常也按提交归一为 CITY", async () => {
  const prov = await app.prisma.place.create({
    data: { name: "山东省", level: "PROVINCE", lat: 36.67, lng: 117.02 },
  });
  const legacy = await app.prisma.place.create({
    data: { name: "济南市", level: "PROVINCE", lat: 36.65, lng: 117.12 },
  });
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
  expect(res.statusCode).toBe(201);
  const adopted = await app.prisma.place.findUniqueOrThrow({ where: { id: legacy.id } });
  expect(adopted).toMatchObject({
    parentId: prov.id, level: "CITY", lat: 36.65, lng: 117.12,
  });
  expect(await app.prisma.place.count()).toBe(3);
});

test("补挂：收编后重名仍 409，且收编与已建省保留（修复性写入不回滚）", async () => {
  const legacy = await app.prisma.place.create({
    data: { name: "济南市", level: "CITY", lat: 36.65, lng: 117.12 },
  });
  await app.prisma.place.create({
    data: { name: "芙蓉街", level: "POI", parentId: legacy.id, lat: 36.665, lng: 117.023 },
  });
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
  expect(res.statusCode).toBe(409);
  expect(res.json()).toEqual({ error: "duplicate_name" });
  const adopted = await app.prisma.place.findUniqueOrThrow({ where: { id: legacy.id } });
  const prov = await app.prisma.place.findFirstOrThrow({ where: { name: "山东省" } });
  expect(adopted.parentId).toBe(prov.id);
  expect(await app.prisma.place.findMany({ where: { name: "济南市" } })).toHaveLength(1);
});

test("补挂：多个同名链顶取最老者，其余保持链顶", async () => {
  const older = await app.prisma.place.create({
    data: {
      name: "济南市", level: "CITY", lat: 36.65, lng: 117.12,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
  });
  const newer = await app.prisma.place.create({
    data: {
      name: "济南市", level: "CITY", lat: 36.66, lng: 117.13,
      createdAt: new Date("2026-06-01T00:00:00Z"),
    },
  });
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
  expect((await app.prisma.place.findUniqueOrThrow({ where: { id: older.id } })).parentId)
    .toBe(prov.id);
  expect((await app.prisma.place.findUniqueOrThrow({ where: { id: newer.id } })).parentId)
    .toBeNull();
});

test("链顶跳只复用不收编不升级：遗留 CITY 链顶按省级提交仍保持原 level——升级属 import-places 重跑/手工 PATCH 职责", async () => {
  const legacyBj = await app.prisma.place.create({
    data: { name: "北京市", level: "CITY", lat: 39.9, lng: 116.4 },
  });
  const res = await app.inject({
    method: "POST", url: "/admin/places", headers: ADMIN_AUTH,
    payload: {
      name: "什刹海", level: "POI", lat: 39.9403, lng: 116.383,
      ancestors: [{ name: "北京市", level: "PROVINCE" }],
    },
  });
  expect(res.statusCode).toBe(201);
  expect(res.json().parentId).toBe(legacyBj.id);
  const bj = await app.prisma.place.findUniqueOrThrow({ where: { id: legacyBj.id } });
  expect(bj).toMatchObject({ level: "CITY", parentId: null });
  expect(await app.prisma.place.count()).toBe(2);
});

test("name 统一 trim：建点名首尾空白入库前剔除，空白差异不再绕过重名预检", async () => {
  const { city } = await seedTree(app);
  const res = await app.inject({
    method: "POST", url: "/admin/places", headers: ADMIN_AUTH,
    payload: { name: " 芙蓉街 ", level: "POI", parentId: city.id, lat: 36.665, lng: 117.023 },
  });
  expect(res.statusCode).toBe(409);
  expect(res.json()).toEqual({ error: "duplicate_name" });

  const created = await app.inject({
    method: "POST", url: "/admin/places", headers: ADMIN_AUTH,
    payload: { name: " 老商埠 ", level: "POI", parentId: city.id, lat: 36.67, lng: 117.0 },
  });
  expect(created.statusCode).toBe(201);
  expect(created.json().name).toBe("老商埠");
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
      ancestors: [{ name: "北京市", level: "PROVINCE", lat: 39.9042, lng: 116.4074 }],
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
