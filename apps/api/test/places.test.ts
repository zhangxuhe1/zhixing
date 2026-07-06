import { afterAll, beforeEach, expect, test } from "vitest";
import { ADMIN_AUTH, resetDb, testApp } from "./helpers.js";

const app = testApp();
beforeEach(() => resetDb(app));
afterAll(async () => app.close());

test("POST /admin/places 需要鉴权", async () => {
  const res = await app.inject({ method: "POST", url: "/admin/places", payload: {} });
  expect(res.statusCode).toBe(401);
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
  expect(detail.json().children).toHaveLength(1);
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
