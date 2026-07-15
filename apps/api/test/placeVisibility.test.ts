import { afterAll, beforeEach, expect, test } from "vitest";
import { resetDb, testApp, userAuth } from "./helpers.js";

const app = testApp();
beforeEach(() => resetDb(app));
afterAll(async () => app.close());

async function submitPlace(headers: Record<string, string>, name: string, lat = 30, lng = 110) {
  const res = await app.inject({ method: "POST", url: "/places", headers, payload: { name, lat, lng } });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}

test("pins:本人见自己的 PENDING/REJECTED,他人与匿名不见;DTO 带 status", async () => {
  await app.prisma.place.create({ data: { name: "官方点", level: "DISTRICT", lat: 31, lng: 111 } });
  const alice = await userAuth(app, "alice");
  const bob = await userAuth(app, "bob");
  const pending = await submitPlace(alice.headers, "洪家楼");
  const rejected = await submitPlace(alice.headers, "老商埠");
  await app.prisma.place.update({ where: { id: rejected.id }, data: { status: "REJECTED" } });

  const mine = (await app.inject({ method: "GET", url: "/places/pins", headers: alice.headers })).json() as Array<{ id: string; status: string }>;
  expect(mine.map((p) => p.id)).toContain(pending.id);
  expect(mine.map((p) => p.id)).toContain(rejected.id);
  expect(mine.find((p) => p.id === pending.id)?.status).toBe("PENDING");
  // 公开面禁字段回归:归属者 id 绝不外传(CLAUDE.md 惯例断言)
  expect(mine.find((p) => p.id === pending.id)).not.toHaveProperty("createdById");

  const others = (await app.inject({ method: "GET", url: "/places/pins", headers: bob.headers })).json() as Array<{ id: string }>;
  expect(others.map((p) => p.id)).not.toContain(pending.id);

  const anon = (await app.inject({ method: "GET", url: "/places/pins" })).json() as Array<{ id: string }>;
  expect(anon.map((p) => p.id)).not.toContain(pending.id);
  expect(anon).toHaveLength(1); // 只有官方点
});

test("搜索:本人可搜到自己的 PENDING;REJECTED 不进搜索;他人不见", async () => {
  const alice = await userAuth(app, "alice");
  const bob = await userAuth(app, "bob");
  const pending = await submitPlace(alice.headers, "洪家楼");
  const rejected = await submitPlace(alice.headers, "老商埠");
  await app.prisma.place.update({ where: { id: rejected.id }, data: { status: "REJECTED" } });

  const mine = (await app.inject({ method: "GET", url: "/search?q=洪家楼", headers: alice.headers })).json() as Array<{ id: string }>;
  expect(mine.map((p) => p.id)).toContain(pending.id);
  expect(mine.find((p) => p.id === pending.id)).not.toHaveProperty("createdById");

  const mineRejected = (await app.inject({ method: "GET", url: "/search?q=老商埠", headers: alice.headers })).json() as Array<{ id: string }>;
  expect(mineRejected).toHaveLength(0);

  const others = (await app.inject({ method: "GET", url: "/search?q=洪家楼", headers: bob.headers })).json() as Array<{ id: string }>;
  expect(others).toHaveLength(0);
});

test("详情:非本人的 PENDING 404,本人 200 且带 status", async () => {
  const alice = await userAuth(app, "alice");
  const bob = await userAuth(app, "bob");
  const pending = await submitPlace(alice.headers, "洪家楼");

  const mine = await app.inject({ method: "GET", url: `/places/${pending.id}`, headers: alice.headers });
  expect(mine.statusCode).toBe(200);
  expect(mine.json().status).toBe("PENDING");

  expect((await app.inject({ method: "GET", url: `/places/${pending.id}`, headers: bob.headers })).statusCode).toBe(404);
  expect((await app.inject({ method: "GET", url: `/places/${pending.id}` })).statusCode).toBe(404);
});

test("random 绝不落在非 ACTIVE 地点(即使它有卡)", async () => {
  const alice = await userAuth(app, "alice");
  const pending = await submitPlace(alice.headers, "洪家楼");
  await app.prisma.card.create({
    data: {
      placeId: pending.id, category: "ANECDOTE", title: "x", sources: [],
      blocks: { create: [{ order: 0, type: "TEXT", text: "a".repeat(60) }] },
    },
  });
  const res = await app.inject({ method: "GET", url: "/places/random", headers: alice.headers });
  expect(res.statusCode).toBe(404); // 唯一有卡的点是 PENDING → 无可随机
});

test("GET /places 列表收归 admin", async () => {
  expect((await app.inject({ method: "GET", url: "/places" })).statusCode).toBe(401);
});

test("公开面:他人的 PENDING 地点 stories/photo-wall 404,本人可见(空列表)", async () => {
  const alice = await userAuth(app, "alice");
  const bob = await userAuth(app, "bob");
  const pending = await submitPlace(alice.headers, "洪家楼");

  const mine = await app.inject({
    method: "GET", url: `/places/${pending.id}/stories`, headers: alice.headers,
  });
  expect(mine.statusCode).toBe(200);
  expect(mine.json().items).toEqual([]);

  expect((await app.inject({
    method: "GET", url: `/places/${pending.id}/stories`, headers: bob.headers,
  })).statusCode).toBe(404);
  expect((await app.inject({
    method: "GET", url: `/places/${pending.id}/photo-wall`, headers: bob.headers,
  })).statusCode).toBe(404);
});
