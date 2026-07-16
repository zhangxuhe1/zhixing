import { afterAll, beforeEach, expect, test } from "vitest";
import { ADMIN_AUTH, resetDb, testApp } from "./helpers.js";

const app = testApp();
beforeEach(() => resetDb(app));
afterAll(async () => app.close());

test("POST /admin/places 需要鉴权", async () => {
  const res = await app.inject({ method: "POST", url: "/admin/places", payload: {} });
  expect(res.statusCode).toBe(401);
});

test("地点库保持受控：不暴露用户建点端点或远程开关", async () => {
  const create = await app.inject({
    method: "POST",
    url: "/places",
    payload: { name: "用户自定义地点", lat: 36.65, lng: 117.12 },
  });
  expect(create.statusCode).toBe(404);
  expect(create.json()).toEqual({ error: "not_found" });
  expect(await app.prisma.place.count()).toBe(0);

  const remoteConfig = await app.inject({ method: "GET", url: "/app-config" });
  expect(remoteConfig.statusCode).toBe(200);
  expect(remoteConfig.json()).toEqual({ shareLandingUrl: expect.any(String) });
});

test("创建并查询地点树", async () => {
  const city = await app.inject({
    method: "POST",
    url: "/admin/places",
    headers: ADMIN_AUTH,
    payload: { name: "北京市", level: "CITY", lat: 39.9042, lng: 116.4074 },
  });
  expect(city.statusCode).toBe(201);
  const cityId = city.json().id as string;

  const spot = await app.inject({
    method: "POST",
    url: "/admin/places",
    headers: ADMIN_AUTH,
    payload: { name: "什刹海", level: "DISTRICT", parentId: cityId, lat: 39.94, lng: 116.383 },
  });
  expect(spot.statusCode).toBe(201);

  const list = await app.inject({ method: "GET", url: `/places?parentId=${cityId}` });
  expect(list.json().map((p: { name: string }) => p.name)).toEqual(["什刹海"]);

  const detail = await app.inject({ method: "GET", url: `/places/${cityId}` });
  expect(detail.json().ancestors).toEqual([]); // 链顶无祖先
  expect(detail.json()).not.toHaveProperty("children"); // M3 起 DTO 移除 children
});

test("非法 body 返回 400", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/admin/places",
    headers: ADMIN_AUTH,
    payload: { name: "", level: "BAD" },
  });
  expect(res.statusCode).toBe(400);
});

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
  // 逐字段 DTO：不外传 createdAt/parentId 之外的内部字段
  expect(Object.keys(res.json()).sort()).toEqual(
    ["ancestors", "id", "intro", "lat", "level", "links", "lng", "name"].sort(),
  );
});
