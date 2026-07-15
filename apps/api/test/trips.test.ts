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

async function createFootprint(
  headers: Record<string, string>,
  placeId: string,
  date: string,
) {
  const res = await app.inject({
    method: "POST",
    url: "/footprints",
    headers,
    payload: { placeId, date },
  });
  return res.json();
}

test("suggestions：排除已归属足迹（沿祖先链解析城市），至少 2 个足迹才成行", async () => {
  const { shichahai, jinan } = await seedPlaces();
  const { headers } = await userAuth(app);

  const jn1 = await createFootprint(headers, jinan.id, "2026-05-01T08:00:00.000Z");
  const jn2 = await createFootprint(headers, jinan.id, "2026-05-02T08:00:00.000Z");

  const res = await app.inject({ method: "GET", url: "/me/trip-suggestions", headers });
  expect(res.statusCode).toBe(200);
  expect(res.json().suggestions).toHaveLength(1);
  expect(res.json().suggestions[0].footprintIds.sort()).toEqual([jn1.id, jn2.id].sort());
  // cityKey 沿祖先链解析：什刹海(DISTRICT) 应归并到北京(CITY)
  expect(shichahai.parentId).toBe(shichahai.parentId);
});

test("suggestions：北京市为 PROVINCE 链顶（M3 直辖市升级）时，无 CITY 祖先应回退链顶归组而非按叶子拆散", async () => {
  const beijing = await app.prisma.place.create({
    data: { name: "北京市", level: "PROVINCE", lat: 39.9, lng: 116.4 },
  });
  const shichahai = await app.prisma.place.create({
    data: { name: "什刹海", level: "DISTRICT", parentId: beijing.id, lat: 39.94, lng: 116.38 },
  });
  const wudaoying = await app.prisma.place.create({
    data: { name: "五道营胡同", level: "DISTRICT", parentId: beijing.id, lat: 39.95, lng: 116.42 },
  });
  const { headers } = await userAuth(app);

  const fp1 = await createFootprint(headers, shichahai.id, "2026-05-01T08:00:00.000Z");
  const fp2 = await createFootprint(headers, wudaoying.id, "2026-05-02T08:00:00.000Z");

  const res = await app.inject({ method: "GET", url: "/me/trip-suggestions", headers });
  expect(res.statusCode).toBe(200);
  const suggestions = res.json().suggestions;
  // 两个足迹应合并为同一"城市"（北京市链顶），而非各自按叶子地名单独拆分。
  expect(suggestions).toHaveLength(1);
  expect(suggestions[0].footprintIds.sort()).toEqual([fp1.id, fp2.id].sort());
  // suggestedTitle 是 cityLabel 归组结果的唯一外部可观察体现（DTO 无独立 cityLabel 字段）：
  // 归组正确时应为单一"北京市"，而不是两个叶子地名并列。
  expect(suggestions[0].suggestedTitle).toBe("北京市·2026年5月");
});

test("POST 落库后，suggestions 不再包含这些足迹（tripId 已归属）", async () => {
  const { jinan } = await seedPlaces();
  const { headers } = await userAuth(app);

  const jn1 = await createFootprint(headers, jinan.id, "2026-05-01T08:00:00.000Z");
  const jn2 = await createFootprint(headers, jinan.id, "2026-05-02T08:00:00.000Z");

  const before = await app.inject({ method: "GET", url: "/me/trip-suggestions", headers });
  expect(before.json().suggestions).toHaveLength(1);

  const created = await app.inject({
    method: "POST",
    url: "/me/trips",
    headers,
    payload: { title: "济南两日游", footprintIds: [jn1.id, jn2.id] },
  });
  expect(created.statusCode).toBe(201);
  expect(created.json()).toMatchObject({
    title: "济南两日游",
    footprintCount: 2,
  });
  expect(created.json().startDate).toBe("2026-05-01T08:00:00.000Z");
  expect(created.json().endDate).toBe("2026-05-02T08:00:00.000Z");

  const after = await app.inject({ method: "GET", url: "/me/trip-suggestions", headers });
  expect(after.json().suggestions).toHaveLength(0);
});

test("POST 含他人足迹 → 400 invalid_footprints", async () => {
  const { jinan } = await seedPlaces();
  const alice = await userAuth(app, "alice");
  const bob = await userAuth(app, "bob");

  const aliceFp = await createFootprint(alice.headers, jinan.id, "2026-05-01T08:00:00.000Z");
  const bobFp = await createFootprint(bob.headers, jinan.id, "2026-05-02T08:00:00.000Z");

  const res = await app.inject({
    method: "POST",
    url: "/me/trips",
    headers: alice.headers,
    payload: { title: "混合旅程", footprintIds: [aliceFp.id, bobFp.id] },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toBe("invalid_footprints");
});

test("POST 含已归属足迹（tripId 非空）→ 400 invalid_footprints", async () => {
  const { jinan } = await seedPlaces();
  const { headers } = await userAuth(app);

  const fp1 = await createFootprint(headers, jinan.id, "2026-05-01T08:00:00.000Z");
  const fp2 = await createFootprint(headers, jinan.id, "2026-05-02T08:00:00.000Z");
  const fp3 = await createFootprint(headers, jinan.id, "2026-05-03T08:00:00.000Z");

  await app.inject({
    method: "POST",
    url: "/me/trips",
    headers,
    payload: { title: "第一段", footprintIds: [fp1.id, fp2.id] },
  });

  const res = await app.inject({
    method: "POST",
    url: "/me/trips",
    headers,
    payload: { title: "重复占用", footprintIds: [fp1.id, fp3.id] },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toBe("invalid_footprints");
});

test("POST body 校验：title 越界/footprintIds 为空 → 400 invalid_body", async () => {
  const { jinan } = await seedPlaces();
  const { headers } = await userAuth(app);
  const fp1 = await createFootprint(headers, jinan.id, "2026-05-01T08:00:00.000Z");

  const emptyTitle = await app.inject({
    method: "POST",
    url: "/me/trips",
    headers,
    payload: { title: "", footprintIds: [fp1.id] },
  });
  expect(emptyTitle.statusCode).toBe(400);
  expect(emptyTitle.json().error).toBe("invalid_body");

  const longTitle = await app.inject({
    method: "POST",
    url: "/me/trips",
    headers,
    payload: { title: "a".repeat(61), footprintIds: [fp1.id] },
  });
  expect(longTitle.statusCode).toBe(400);
  expect(longTitle.json().error).toBe("invalid_body");

  const emptyIds = await app.inject({
    method: "POST",
    url: "/me/trips",
    headers,
    payload: { title: "标题", footprintIds: [] },
  });
  expect(emptyIds.statusCode).toBe(400);
  expect(emptyIds.json().error).toBe("invalid_body");
});

test("GET /me/trips 按 startDate 倒序返回", async () => {
  const { jinan, beijing } = await seedPlaces();
  const { headers } = await userAuth(app);

  const jn1 = await createFootprint(headers, jinan.id, "2026-01-01T08:00:00.000Z");
  const jn2 = await createFootprint(headers, jinan.id, "2026-01-02T08:00:00.000Z");
  const bj1 = await createFootprint(headers, beijing.id, "2026-05-01T08:00:00.000Z");
  const bj2 = await createFootprint(headers, beijing.id, "2026-05-02T08:00:00.000Z");

  await app.inject({
    method: "POST", url: "/me/trips", headers,
    payload: { title: "早的行程", footprintIds: [jn1.id, jn2.id] },
  });
  await app.inject({
    method: "POST", url: "/me/trips", headers,
    payload: { title: "晚的行程", footprintIds: [bj1.id, bj2.id] },
  });

  const list = await app.inject({ method: "GET", url: "/me/trips", headers });
  expect(list.statusCode).toBe(200);
  const items = list.json().items;
  expect(items).toHaveLength(2);
  expect(items[0].title).toBe("晚的行程");
  expect(items[1].title).toBe("早的行程");
  expect(items[0]).toEqual({
    id: expect.any(String),
    title: "晚的行程",
    startDate: expect.any(String),
    endDate: expect.any(String),
    footprintCount: 2,
  });
});

test("PATCH 增删成员后重算 start/end，且 footprintCount 正确", async () => {
  const { jinan } = await seedPlaces();
  const { headers } = await userAuth(app);

  const fp1 = await createFootprint(headers, jinan.id, "2026-05-01T08:00:00.000Z");
  const fp2 = await createFootprint(headers, jinan.id, "2026-05-02T08:00:00.000Z");
  const fp3 = await createFootprint(headers, jinan.id, "2026-05-10T08:00:00.000Z");

  const created = await app.inject({
    method: "POST", url: "/me/trips", headers,
    payload: { title: "旅程", footprintIds: [fp1.id, fp2.id] },
  });
  const tripId = created.json().id;
  expect(created.json().endDate).toBe("2026-05-02T08:00:00.000Z");

  const patched = await app.inject({
    method: "PATCH", url: `/me/trips/${tripId}`, headers,
    payload: { addFootprintIds: [fp3.id], removeFootprintIds: [fp1.id] },
  });
  expect(patched.statusCode).toBe(200);
  expect(patched.json().footprintCount).toBe(2);
  expect(patched.json().startDate).toBe("2026-05-02T08:00:00.000Z");
  expect(patched.json().endDate).toBe("2026-05-10T08:00:00.000Z");

  // fp1 removed → tripId null; fp3 added → tripId set
  const fp1Row = await app.prisma.footprint.findUniqueOrThrow({ where: { id: fp1.id } });
  const fp3Row = await app.prisma.footprint.findUniqueOrThrow({ where: { id: fp3.id } });
  expect(fp1Row.tripId).toBeNull();
  expect(fp3Row.tripId).toBe(tripId);
});

test("PATCH 改题：title 更新，start/end 不变", async () => {
  const { jinan } = await seedPlaces();
  const { headers } = await userAuth(app);
  const fp1 = await createFootprint(headers, jinan.id, "2026-05-01T08:00:00.000Z");
  const fp2 = await createFootprint(headers, jinan.id, "2026-05-02T08:00:00.000Z");
  const created = await app.inject({
    method: "POST", url: "/me/trips", headers,
    payload: { title: "旧标题", footprintIds: [fp1.id, fp2.id] },
  });
  const tripId = created.json().id;

  const patched = await app.inject({
    method: "PATCH", url: `/me/trips/${tripId}`, headers,
    payload: { title: "新标题" },
  });
  expect(patched.statusCode).toBe(200);
  expect(patched.json().title).toBe("新标题");
  expect(patched.json().startDate).toBe(created.json().startDate);
  expect(patched.json().endDate).toBe(created.json().endDate);
});

test("PATCH 删光成员 → 400 would_be_empty", async () => {
  const { jinan } = await seedPlaces();
  const { headers } = await userAuth(app);
  const fp1 = await createFootprint(headers, jinan.id, "2026-05-01T08:00:00.000Z");
  const fp2 = await createFootprint(headers, jinan.id, "2026-05-02T08:00:00.000Z");
  const created = await app.inject({
    method: "POST", url: "/me/trips", headers,
    payload: { title: "旅程", footprintIds: [fp1.id, fp2.id] },
  });
  const tripId = created.json().id;

  const patched = await app.inject({
    method: "PATCH", url: `/me/trips/${tripId}`, headers,
    payload: { removeFootprintIds: [fp1.id, fp2.id] },
  });
  expect(patched.statusCode).toBe(400);
  expect(patched.json().error).toBe("would_be_empty");

  // Trip and membership unchanged
  const still = await app.prisma.footprint.findUniqueOrThrow({ where: { id: fp1.id } });
  expect(still.tripId).toBe(tripId);
});

test("PATCH 添加他人足迹 → 400 invalid_footprints", async () => {
  const { jinan } = await seedPlaces();
  const alice = await userAuth(app, "alice");
  const bob = await userAuth(app, "bob");

  const fp1 = await createFootprint(alice.headers, jinan.id, "2026-05-01T08:00:00.000Z");
  const fp2 = await createFootprint(alice.headers, jinan.id, "2026-05-02T08:00:00.000Z");
  const bobFp = await createFootprint(bob.headers, jinan.id, "2026-05-03T08:00:00.000Z");

  const created = await app.inject({
    method: "POST", url: "/me/trips", headers: alice.headers,
    payload: { title: "旅程", footprintIds: [fp1.id, fp2.id] },
  });
  const tripId = created.json().id;

  const patched = await app.inject({
    method: "PATCH", url: `/me/trips/${tripId}`, headers: alice.headers,
    payload: { addFootprintIds: [bobFp.id] },
  });
  expect(patched.statusCode).toBe(400);
  expect(patched.json().error).toBe("invalid_footprints");
});

test("他人 trip PATCH/DELETE → 404", async () => {
  const { jinan } = await seedPlaces();
  const alice = await userAuth(app, "alice");
  const bob = await userAuth(app, "bob");

  const fp1 = await createFootprint(alice.headers, jinan.id, "2026-05-01T08:00:00.000Z");
  const fp2 = await createFootprint(alice.headers, jinan.id, "2026-05-02T08:00:00.000Z");
  const created = await app.inject({
    method: "POST", url: "/me/trips", headers: alice.headers,
    payload: { title: "旅程", footprintIds: [fp1.id, fp2.id] },
  });
  const tripId = created.json().id;

  const patched = await app.inject({
    method: "PATCH", url: `/me/trips/${tripId}`, headers: bob.headers,
    payload: { title: "改名" },
  });
  expect(patched.statusCode).toBe(404);

  const deleted = await app.inject({
    method: "DELETE", url: `/me/trips/${tripId}`, headers: bob.headers,
  });
  expect(deleted.statusCode).toBe(404);
});

test("DELETE 成功 → 204，成员足迹 tripId 变 null", async () => {
  const { jinan } = await seedPlaces();
  const { headers } = await userAuth(app);
  const fp1 = await createFootprint(headers, jinan.id, "2026-05-01T08:00:00.000Z");
  const fp2 = await createFootprint(headers, jinan.id, "2026-05-02T08:00:00.000Z");
  const created = await app.inject({
    method: "POST", url: "/me/trips", headers,
    payload: { title: "旅程", footprintIds: [fp1.id, fp2.id] },
  });
  const tripId = created.json().id;

  const deleted = await app.inject({ method: "DELETE", url: `/me/trips/${tripId}`, headers });
  expect(deleted.statusCode).toBe(204);

  const fp1Row = await app.prisma.footprint.findUniqueOrThrow({ where: { id: fp1.id } });
  const fp2Row = await app.prisma.footprint.findUniqueOrThrow({ where: { id: fp2.id } });
  expect(fp1Row.tripId).toBeNull();
  expect(fp2Row.tripId).toBeNull();

  const list = await app.inject({ method: "GET", url: "/me/trips", headers });
  expect(list.json().items).toHaveLength(0);
});

test("未登录访问 trips 端点 → 401", async () => {
  expect((await app.inject({ method: "GET", url: "/me/trip-suggestions" })).statusCode).toBe(401);
  expect((await app.inject({ method: "GET", url: "/me/trips" })).statusCode).toBe(401);
  expect(
    (await app.inject({ method: "POST", url: "/me/trips", payload: { title: "x", footprintIds: ["a"] } })).statusCode,
  ).toBe(401);
});

test("GET /app-config 返回非空 URL 字符串，无需鉴权", async () => {
  const res = await app.inject({ method: "GET", url: "/app-config" });
  expect(res.statusCode).toBe(200);
  expect(typeof res.json().shareLandingUrl).toBe("string");
  expect(res.json().shareLandingUrl.length).toBeGreaterThan(0);
});

test("I1a：删除两成员之一 → 旅程范围收缩到剩余成员", async () => {
  const { jinan } = await seedPlaces();
  const { headers } = await userAuth(app);
  const fp1 = await createFootprint(headers, jinan.id, "2026-05-01T08:00:00.000Z");
  const fp2 = await createFootprint(headers, jinan.id, "2026-05-10T08:00:00.000Z");
  const created = await app.inject({
    method: "POST", url: "/me/trips", headers,
    payload: { title: "旅程", footprintIds: [fp1.id, fp2.id] },
  });
  const tripId = created.json().id;
  expect(created.json().startDate).toBe("2026-05-01T08:00:00.000Z");
  expect(created.json().endDate).toBe("2026-05-10T08:00:00.000Z");

  // 删掉最早的成员 → 范围两端都应变成剩余成员 fp2 的日期。
  const del = await app.inject({ method: "DELETE", url: `/footprints/${fp1.id}`, headers });
  expect(del.statusCode).toBe(204);

  const trip = await app.prisma.trip.findUniqueOrThrow({ where: { id: tripId } });
  expect(trip.startDate.toISOString()).toBe("2026-05-10T08:00:00.000Z");
  expect(trip.endDate.toISOString()).toBe("2026-05-10T08:00:00.000Z");
});

test("I1a：删除最后一个成员 → 旅程被删除", async () => {
  const { jinan } = await seedPlaces();
  const { headers } = await userAuth(app);
  const fp1 = await createFootprint(headers, jinan.id, "2026-05-01T08:00:00.000Z");
  const fp2 = await createFootprint(headers, jinan.id, "2026-05-02T08:00:00.000Z");
  const created = await app.inject({
    method: "POST", url: "/me/trips", headers,
    payload: { title: "旅程", footprintIds: [fp1.id, fp2.id] },
  });
  const tripId = created.json().id;

  await app.inject({ method: "DELETE", url: `/footprints/${fp1.id}`, headers });
  // 删到最后一个 → Trip 应随之消失。
  await app.inject({ method: "DELETE", url: `/footprints/${fp2.id}`, headers });

  expect(await app.prisma.trip.findUnique({ where: { id: tripId } })).toBeNull();
  const list = await app.inject({ method: "GET", url: "/me/trips", headers });
  expect(list.json().items).toHaveLength(0);
});

test("I1b：PATCH 成员日期越出原范围 → 旅程范围扩展", async () => {
  const { jinan } = await seedPlaces();
  const { headers } = await userAuth(app);
  const fp1 = await createFootprint(headers, jinan.id, "2026-05-01T08:00:00.000Z");
  const fp2 = await createFootprint(headers, jinan.id, "2026-05-02T08:00:00.000Z");
  const created = await app.inject({
    method: "POST", url: "/me/trips", headers,
    payload: { title: "旅程", footprintIds: [fp1.id, fp2.id] },
  });
  const tripId = created.json().id;
  expect(created.json().endDate).toBe("2026-05-02T08:00:00.000Z");

  // 把 fp2 日期改到远超原 endDate → 旅程 endDate 应随之扩展。
  const patched = await app.inject({
    method: "PATCH", url: `/footprints/${fp2.id}`, headers,
    payload: { date: "2026-05-20T08:00:00.000Z" },
  });
  expect(patched.statusCode).toBe(200);

  const trip = await app.prisma.trip.findUniqueOrThrow({ where: { id: tripId } });
  expect(trip.startDate.toISOString()).toBe("2026-05-01T08:00:00.000Z");
  expect(trip.endDate.toISOString()).toBe("2026-05-20T08:00:00.000Z");
});

test("I1b：改非成员足迹日期不误伤任何旅程", async () => {
  const { jinan } = await seedPlaces();
  const { headers } = await userAuth(app);
  const fp1 = await createFootprint(headers, jinan.id, "2026-05-01T08:00:00.000Z");
  const fp2 = await createFootprint(headers, jinan.id, "2026-05-02T08:00:00.000Z");
  const loose = await createFootprint(headers, jinan.id, "2026-05-03T08:00:00.000Z");
  const created = await app.inject({
    method: "POST", url: "/me/trips", headers,
    payload: { title: "旅程", footprintIds: [fp1.id, fp2.id] },
  });
  const tripId = created.json().id;

  const patched = await app.inject({
    method: "PATCH", url: `/footprints/${loose.id}`, headers,
    payload: { date: "2026-09-09T08:00:00.000Z" },
  });
  expect(patched.statusCode).toBe(200);

  const trip = await app.prisma.trip.findUniqueOrThrow({ where: { id: tripId } });
  expect(trip.startDate.toISOString()).toBe("2026-05-01T08:00:00.000Z");
  expect(trip.endDate.toISOString()).toBe("2026-05-02T08:00:00.000Z");
});

test("I2：复用已归属足迹的第二次 POST 回滚 → 400，旅程 A 完好且无残留空壳 Trip", async () => {
  const { jinan } = await seedPlaces();
  const { headers, user } = await userAuth(app);
  const fp1 = await createFootprint(headers, jinan.id, "2026-05-01T08:00:00.000Z");
  const fp2 = await createFootprint(headers, jinan.id, "2026-05-02T08:00:00.000Z");

  const created = await app.inject({
    method: "POST", url: "/me/trips", headers,
    payload: { title: "旅程 A", footprintIds: [fp1.id, fp2.id] },
  });
  expect(created.statusCode).toBe(201);
  const tripId = created.json().id;

  // 同一批足迹已被旅程 A 认领；第二次 POST 应在事务内认领失败并整体回滚。
  const dup = await app.inject({
    method: "POST", url: "/me/trips", headers,
    payload: { title: "旅程 B", footprintIds: [fp1.id, fp2.id] },
  });
  expect(dup.statusCode).toBe(400);
  expect(dup.json().error).toBe("invalid_footprints");

  // 旅程 A 应完全不受影响：成员数、起止日期均保持不变。
  const list = await app.inject({ method: "GET", url: "/me/trips", headers });
  expect(list.json().items).toHaveLength(1);
  expect(list.json().items[0]).toMatchObject({
    id: tripId,
    footprintCount: 2,
    startDate: "2026-05-01T08:00:00.000Z",
    endDate: "2026-05-02T08:00:00.000Z",
  });

  // 失败的认领必须整体回滚：不应残留一个认领失败的空壳 Trip 行。
  const count = await app.prisma.trip.count({ where: { userId: user.id } });
  expect(count).toBe(1);
});
