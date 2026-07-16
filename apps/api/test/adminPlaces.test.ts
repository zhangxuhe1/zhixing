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
