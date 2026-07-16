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
