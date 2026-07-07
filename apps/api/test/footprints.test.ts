import { afterAll, beforeEach, expect, test } from "vitest";
import { resetDb, testApp, userAuth } from "./helpers.js";

const app = testApp();
beforeEach(() => resetDb(app));
afterAll(async () => app.close());

async function seedPlaces() {
  const beijing = await app.prisma.place.create({
    data: { name: "北京市", level: "CITY", lat: 39.9, lng: 116.4 },
  });
  const shichahai = await app.prisma.place.create({
    data: { name: "什刹海", level: "DISTRICT", parentId: beijing.id, lat: 39.94, lng: 116.38 },
  });
  const jinan = await app.prisma.place.create({
    data: { name: "济南市", level: "CITY", lat: 36.65, lng: 117.12 },
  });
  return { beijing, shichahai, jinan };
}

test("创建/列出/删除足迹（默认私密）", async () => {
  const { shichahai } = await seedPlaces();
  const { headers } = await userAuth(app);

  const created = await app.inject({
    method: "POST", url: "/footprints", headers,
    payload: { placeId: shichahai.id, text: "银锭桥看了落日", date: "2026-05-01T10:00:00.000Z" },
  });
  expect(created.statusCode).toBe(201);
  expect(created.json().place.name).toBe("什刹海");
  expect((await app.prisma.footprint.findFirstOrThrow()).visibility).toBe("PRIVATE");

  const list = await app.inject({ method: "GET", url: "/me/footprints", headers });
  expect(list.json()).toHaveLength(1);

  const del = await app.inject({
    method: "DELETE", url: `/footprints/${created.json().id}`, headers,
  });
  expect(del.statusCode).toBe(204);
  expect((await app.inject({ method: "GET", url: "/me/footprints", headers })).json()).toHaveLength(0);
});

test("别人的足迹删不掉、列不到", async () => {
  const { shichahai } = await seedPlaces();
  const alice = await userAuth(app, "alice");
  const bob = await userAuth(app, "bob");
  const created = await app.inject({
    method: "POST", url: "/footprints", headers: alice.headers,
    payload: { placeId: shichahai.id, date: "2026-05-01T10:00:00.000Z" },
  });
  expect(
    (await app.inject({ method: "DELETE", url: `/footprints/${created.json().id}`, headers: bob.headers })).statusCode,
  ).toBe(404);
  expect((await app.inject({ method: "GET", url: "/me/footprints", headers: bob.headers })).json()).toHaveLength(0);
});

test("统计：城市按祖先链归并", async () => {
  const { beijing, shichahai, jinan } = await seedPlaces();
  const { headers } = await userAuth(app);
  for (const [placeId, date] of [
    [shichahai.id, "2026-05-01T10:00:00.000Z"],
    [beijing.id, "2026-05-02T10:00:00.000Z"],
    [jinan.id, "2026-06-01T10:00:00.000Z"],
  ] as const) {
    await app.inject({ method: "POST", url: "/footprints", headers, payload: { placeId, date } });
  }
  const stats = await app.inject({ method: "GET", url: "/me/stats", headers });
  // 什刹海归并进北京 → 2 城（北京、济南），3 地点，3 足迹
  expect(stats.json()).toEqual({ footprints: 3, places: 3, cities: 2, provinces: 0 });
});

test("placeId 不存在 400；未登录 401", async () => {
  const { headers } = await userAuth(app);
  const bad = await app.inject({
    method: "POST", url: "/footprints", headers,
    payload: { placeId: "nope", date: "2026-05-01T10:00:00.000Z" },
  });
  expect(bad.statusCode).toBe(400);
  expect((await app.inject({ method: "GET", url: "/me/footprints" })).statusCode).toBe(401);
});

test("POST 带 visibility=PUBLIC → PENDING 且 publicRequestedAt 非空", async () => {
  const { shichahai } = await seedPlaces();
  const { headers } = await userAuth(app);
  const created = await app.inject({
    method: "POST", url: "/footprints", headers,
    payload: { placeId: shichahai.id, date: "2026-05-01T10:00:00.000Z", visibility: "PUBLIC" },
  });
  expect(created.statusCode).toBe(201);
  expect(created.json().reviewStatus).toBe("PENDING");
  expect(created.json().visibility).toBe("PUBLIC");
  const row = await app.prisma.footprint.findUniqueOrThrow({ where: { id: created.json().id } });
  expect(row.publicRequestedAt).not.toBeNull();
});

test("PATCH 改 text（APPROVED 公开态）→ 回 PENDING 且 publicRequestedAt 被刷新", async () => {
  const { shichahai } = await seedPlaces();
  const { headers } = await userAuth(app);
  const created = await app.inject({
    method: "POST", url: "/footprints", headers,
    payload: { placeId: shichahai.id, date: "2026-05-01T10:00:00.000Z", visibility: "PUBLIC" },
  });
  const id = created.json().id;
  const oldRequestedAt = new Date("2020-01-01T00:00:00.000Z");
  await app.prisma.footprint.update({
    where: { id },
    data: { reviewStatus: "APPROVED", publicRequestedAt: oldRequestedAt },
  });

  const patched = await app.inject({
    method: "PATCH", url: `/footprints/${id}`, headers,
    payload: { text: "新的文字" },
  });
  expect(patched.statusCode).toBe(200);
  expect(patched.json().reviewStatus).toBe("PENDING");
  const row = await app.prisma.footprint.findUniqueOrThrow({ where: { id } });
  expect(row.publicRequestedAt).not.toBeNull();
  expect(row.publicRequestedAt!.getTime()).toBeGreaterThan(oldRequestedAt.getTime());
});

test("PATCH 只改 date（私密态）→ reviewStatus 不变", async () => {
  const { shichahai } = await seedPlaces();
  const { headers } = await userAuth(app);
  const created = await app.inject({
    method: "POST", url: "/footprints", headers,
    payload: { placeId: shichahai.id, date: "2026-05-01T10:00:00.000Z" },
  });
  const id = created.json().id;
  const before = await app.prisma.footprint.findUniqueOrThrow({ where: { id } });

  const patched = await app.inject({
    method: "PATCH", url: `/footprints/${id}`, headers,
    payload: { date: "2026-05-02T10:00:00.000Z" },
  });
  expect(patched.statusCode).toBe(200);
  expect(patched.json().reviewStatus).toBe(before.reviewStatus);
  expect(patched.json().date).toBe("2026-05-02T10:00:00.000Z");
});

test("PATCH visibility=PUBLIC → reviewStatus=PENDING", async () => {
  const { shichahai } = await seedPlaces();
  const { headers } = await userAuth(app);
  const created = await app.inject({
    method: "POST", url: "/footprints", headers,
    payload: { placeId: shichahai.id, date: "2026-05-01T10:00:00.000Z" },
  });
  const id = created.json().id;

  const patched = await app.inject({
    method: "PATCH", url: `/footprints/${id}`, headers,
    payload: { visibility: "PUBLIC" },
  });
  expect(patched.statusCode).toBe(200);
  expect(patched.json().visibility).toBe("PUBLIC");
  expect(patched.json().reviewStatus).toBe("PENDING");
});

test("PATCH visibility=PRIVATE（原 APPROVED）→ visibility=PRIVATE 且 reviewStatus 仍 APPROVED", async () => {
  const { shichahai } = await seedPlaces();
  const { headers } = await userAuth(app);
  const created = await app.inject({
    method: "POST", url: "/footprints", headers,
    payload: { placeId: shichahai.id, date: "2026-05-01T10:00:00.000Z", visibility: "PUBLIC" },
  });
  const id = created.json().id;
  await app.prisma.footprint.update({ where: { id }, data: { reviewStatus: "APPROVED" } });

  const patched = await app.inject({
    method: "PATCH", url: `/footprints/${id}`, headers,
    payload: { visibility: "PRIVATE" },
  });
  expect(patched.statusCode).toBe(200);
  expect(patched.json().visibility).toBe("PRIVATE");
  expect(patched.json().reviewStatus).toBe("APPROVED");
});

test("非属主 PATCH → 404", async () => {
  const { shichahai } = await seedPlaces();
  const alice = await userAuth(app, "alice");
  const bob = await userAuth(app, "bob");
  const created = await app.inject({
    method: "POST", url: "/footprints", headers: alice.headers,
    payload: { placeId: shichahai.id, date: "2026-05-01T10:00:00.000Z" },
  });
  const patched = await app.inject({
    method: "PATCH", url: `/footprints/${created.json().id}`, headers: bob.headers,
    payload: { text: "改一下" },
  });
  expect(patched.statusCode).toBe(404);
  expect(patched.json().error).toBe("not_found");
});

test("PATCH 空 body → 400 invalid_body", async () => {
  const { shichahai } = await seedPlaces();
  const { headers } = await userAuth(app);
  const created = await app.inject({
    method: "POST", url: "/footprints", headers,
    payload: { placeId: shichahai.id, date: "2026-05-01T10:00:00.000Z" },
  });
  const patched = await app.inject({
    method: "PATCH", url: `/footprints/${created.json().id}`, headers,
    payload: {},
  });
  expect(patched.statusCode).toBe(400);
  expect(patched.json().error).toBe("invalid_body");
});
