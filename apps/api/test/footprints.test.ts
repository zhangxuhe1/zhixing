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
  expect(created.json()).not.toHaveProperty("userId");
  expect((await app.prisma.footprint.findFirstOrThrow()).visibility).toBe("PRIVATE");

  const list = await app.inject({ method: "GET", url: "/me/footprints", headers });
  expect(list.json()).toHaveLength(1);
  expect(list.json()[0]).not.toHaveProperty("userId");

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

test("统计：DISTRICT 直挂 PROVINCE（无 CITY 祖先）→ cities 按该顶层归并", async () => {
  const province = await app.prisma.place.create({
    data: { name: "云南省", level: "PROVINCE", lat: 25.04, lng: 102.71 },
  });
  const oldTown = await app.prisma.place.create({
    data: { name: "丽江古城", level: "DISTRICT", parentId: province.id, lat: 26.87, lng: 100.23 },
  });
  const { headers } = await userAuth(app);
  await app.inject({
    method: "POST", url: "/footprints", headers,
    payload: { placeId: oldTown.id, date: "2026-05-01T10:00:00.000Z" },
  });
  const stats = await app.inject({ method: "GET", url: "/me/stats", headers });
  // 无 CITY 祖先 → 回退到链顶（省本身）计 1 城；同时该链顶也是 PROVINCE → provinces 计 1
  expect(stats.json()).toEqual({ footprints: 1, places: 1, cities: 1, provinces: 1 });
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
  expect(patched.json()).not.toHaveProperty("userId");
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

// 状态机链式场景：多次 PATCH 连续跨越"已过审/已拒/转私"等历史分支，
// 锁定当前实现在每一步的确切行为，防止未来改动悄悄改变语义。

test("链式1·撤回再公开重新排队：APPROVED→PRIVATE（仍 APPROVED）→PUBLIC（回 PENDING 且 publicRequestedAt 刷新）", async () => {
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

  // 第一跳：撤回为私密 → reviewStatus 原样保留 APPROVED（镜像既有单跳测试）。
  const toPrivate = await app.inject({
    method: "PATCH", url: `/footprints/${id}`, headers,
    payload: { visibility: "PRIVATE" },
  });
  expect(toPrivate.statusCode).toBe(200);
  expect(toPrivate.json().reviewStatus).toBe("APPROVED");

  // 第二跳：重新公开 → 无论此前是什么审核结果，一律回 PENDING 排队，且时间戳被刷新。
  const toPublicAgain = await app.inject({
    method: "PATCH", url: `/footprints/${id}`, headers,
    payload: { visibility: "PUBLIC" },
  });
  expect(toPublicAgain.statusCode).toBe(200);
  expect(toPublicAgain.json().reviewStatus).toBe("PENDING");
  const row = await app.prisma.footprint.findUniqueOrThrow({ where: { id } });
  expect(row.publicRequestedAt).not.toBeNull();
  expect(row.publicRequestedAt!.getTime()).toBeGreaterThan(oldRequestedAt.getTime());
});

test("链式2·拒后改文重提：REJECTED 公开态改文 → 回 PENDING 且 publicRequestedAt 刷新", async () => {
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
    data: { reviewStatus: "REJECTED", publicRequestedAt: oldRequestedAt },
  });

  const patched = await app.inject({
    method: "PATCH", url: `/footprints/${id}`, headers,
    payload: { text: "改过的文字，重新申请公开" },
  });
  expect(patched.statusCode).toBe(200);
  expect(patched.json().reviewStatus).toBe("PENDING");
  const row = await app.prisma.footprint.findUniqueOrThrow({ where: { id } });
  expect(row.publicRequestedAt).not.toBeNull();
  expect(row.publicRequestedAt!.getTime()).toBeGreaterThan(oldRequestedAt.getTime());
});

test("链式3·曾公开转私后改文不触审：APPROVED→PRIVATE 后改文 → reviewStatus 仍 APPROVED 且 publicRequestedAt 不变", async () => {
  const { shichahai } = await seedPlaces();
  const { headers } = await userAuth(app);
  const created = await app.inject({
    method: "POST", url: "/footprints", headers,
    payload: { placeId: shichahai.id, date: "2026-05-01T10:00:00.000Z", visibility: "PUBLIC" },
  });
  const id = created.json().id;
  const requestedAt = new Date("2020-01-01T00:00:00.000Z");
  await app.prisma.footprint.update({
    where: { id },
    data: { reviewStatus: "APPROVED", publicRequestedAt: requestedAt },
  });

  const toPrivate = await app.inject({
    method: "PATCH", url: `/footprints/${id}`, headers,
    payload: { visibility: "PRIVATE" },
  });
  expect(toPrivate.statusCode).toBe(200);
  expect(toPrivate.json().visibility).toBe("PRIVATE");

  // 转私后只改文字（不碰 visibility）：既然当前已是 PRIVATE，不应触发"内容变更回审"分支。
  const patched = await app.inject({
    method: "PATCH", url: `/footprints/${id}`, headers,
    payload: { text: "私密态下随便改改" },
  });
  expect(patched.statusCode).toBe(200);
  expect(patched.json().reviewStatus).toBe("APPROVED");
  const row = await app.prisma.footprint.findUniqueOrThrow({ where: { id } });
  expect(row.reviewStatus).toBe("APPROVED");
  expect(row.publicRequestedAt).toEqual(requestedAt);
});

test("挂 PENDING 地点的足迹:创建时直接公开与事后切公开都 400 place_pending;私密不受限", async () => {
  const { headers } = await userAuth(app, "submitter");
  const created = await app.inject({
    method: "POST", url: "/places", headers,
    payload: { name: "洪家楼", lat: 36.68, lng: 117.06 },
  });
  const placeId = created.json().id as string;

  const publicTry = await app.inject({
    method: "POST", url: "/footprints", headers,
    payload: { placeId, date: "2026-07-01T10:00:00.000+08:00", visibility: "PUBLIC" },
  });
  expect(publicTry.statusCode).toBe(400);
  expect(publicTry.json().error).toBe("place_pending");

  const privateOk = await app.inject({
    method: "POST", url: "/footprints", headers,
    payload: { placeId, date: "2026-07-01T10:00:00.000+08:00" },
  });
  expect(privateOk.statusCode).toBe(201);
  expect(privateOk.json().place.status).toBe("PENDING"); // 编辑器判据字段

  const fpId = privateOk.json().id as string;
  const patchTry = await app.inject({
    method: "PATCH", url: `/footprints/${fpId}`, headers,
    payload: { visibility: "PUBLIC" },
  });
  expect(patchTry.statusCode).toBe(400);
  expect(patchTry.json().error).toBe("place_pending");

  // 地点转正后放行
  await app.prisma.place.update({ where: { id: placeId }, data: { status: "ACTIVE" } });
  const patchOk = await app.inject({
    method: "PATCH", url: `/footprints/${fpId}`, headers,
    payload: { visibility: "PUBLIC" },
  });
  expect(patchOk.statusCode).toBe(200);
  expect(patchOk.json().reviewStatus).toBe("PENDING"); // 正常进足迹审核队列
});
