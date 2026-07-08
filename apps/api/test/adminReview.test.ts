import { afterAll, beforeEach, expect, test } from "vitest";
import { ADMIN_AUTH, resetDb, testApp, userAuth } from "./helpers.js";

const app = testApp();
beforeEach(() => resetDb(app));
afterAll(async () => app.close());

async function seedPlace(name = "什刹海") {
  return app.prisma.place.create({
    data: { name, level: "DISTRICT", lat: 39.94, lng: 116.38 },
  });
}

async function seedCard(placeId: string, title = "银锭观山") {
  return app.prisma.card.create({
    data: {
      placeId,
      category: "ANECDOTE",
      title,
      sources: [],
      blocks: { create: [{ type: "TEXT", text: "一段卡片内容", order: 0 }] },
    },
  });
}

/** 直接建库：PUBLIC+PENDING 的足迹，附带自定义 publicRequestedAt（排序用） */
async function seedPendingFootprint(
  userId: string,
  placeId: string,
  opts: { text?: string; date?: string; publicRequestedAt: string },
) {
  return app.prisma.footprint.create({
    data: {
      userId,
      placeId,
      text: opts.text ?? "一段游记文字",
      date: new Date(opts.date ?? "2026-05-01T10:00:00.000Z"),
      visibility: "PUBLIC",
      reviewStatus: "PENDING",
      publicRequestedAt: new Date(opts.publicRequestedAt),
    },
  });
}

// ---------- GET /admin/review-queue ----------

test("review-queue 只含 PUBLIC+PENDING，按 publicRequestedAt 升序，photos 含 presigned url", async () => {
  const place = await seedPlace();
  const { user } = await userAuth(app, "review-user-1");

  const older = await seedPendingFootprint(user.id, place.id, {
    text: "较早提交",
    publicRequestedAt: "2026-05-01T08:00:00.000Z",
  });
  const newer = await seedPendingFootprint(user.id, place.id, {
    text: "较晚提交",
    publicRequestedAt: "2026-05-02T08:00:00.000Z",
  });

  // 私密足迹（默认 reviewStatus=PENDING，但 visibility=PRIVATE）不应出现
  await app.prisma.footprint.create({
    data: {
      userId: user.id, placeId: place.id, text: "私密的",
      date: new Date("2026-05-01T10:00:00.000Z"), visibility: "PRIVATE",
    },
  });

  // 已 APPROVED 的公开足迹不应出现在队列
  await app.prisma.footprint.create({
    data: {
      userId: user.id, placeId: place.id, text: "已过审",
      date: new Date("2026-05-01T10:00:00.000Z"),
      visibility: "PUBLIC", reviewStatus: "APPROVED",
      publicRequestedAt: new Date("2026-04-01T00:00:00.000Z"),
    },
  });

  const photoKey = `photos/${older.id}/x.png`;
  await app.storage.put(photoKey, Buffer.from("fake-image-bytes"), "image/png");
  await app.prisma.footprintPhoto.create({
    data: { footprintId: older.id, mediaUrl: photoKey },
  });

  const res = await app.inject({ method: "GET", url: "/admin/review-queue", headers: ADMIN_AUTH });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.total).toBe(2);
  expect(body.items).toHaveLength(2);

  // 升序：older 先，newer 后
  expect(body.items[0].footprintId).toBe(older.id);
  expect(body.items[1].footprintId).toBe(newer.id);

  const first = body.items[0];
  expect(first.text).toBe("较早提交");
  expect(first.authorNickname).toBeTruthy();
  expect(first.placeName).toBe(place.name);
  expect(first.publicRequestedAt).toBe("2026-05-01T08:00:00.000Z");
  expect(first.photos).toHaveLength(1);
  expect(first.photos[0].photoId).toBeTruthy();
  expect(first.photos[0].url).toBeTruthy();

  // presigned URL 可实际取回内容（间接验证走的是 presignGet）
  const fetched = await fetch(first.photos[0].url);
  expect(fetched.status).toBe(200);
});

test("review-queue 无 admin token → 401", async () => {
  const res = await app.inject({ method: "GET", url: "/admin/review-queue" });
  expect(res.statusCode).toBe(401);
});

test("review-queue 无待审时 total=0，items=[]", async () => {
  const res = await app.inject({ method: "GET", url: "/admin/review-queue", headers: ADMIN_AUTH });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ total: 0, items: [] });
});

// ---------- POST /admin/review/:footprintId ----------

test("approve → reviewStatus=APPROVED", async () => {
  const place = await seedPlace();
  const { user } = await userAuth(app, "review-user-2");
  const fp = await seedPendingFootprint(user.id, place.id, { publicRequestedAt: "2026-05-01T08:00:00.000Z" });

  const res = await app.inject({
    method: "POST", url: `/admin/review/${fp.id}`, headers: ADMIN_AUTH,
    payload: { action: "approve" },
  });
  expect(res.statusCode).toBe(204);

  const stored = await app.prisma.footprint.findUniqueOrThrow({ where: { id: fp.id } });
  expect(stored.reviewStatus).toBe("APPROVED");
  expect(stored.visibility).toBe("PUBLIC");
});

test("approve 后该足迹在 stories 中可见（S3 消费方视角）", async () => {
  const place = await seedPlace();
  const { user, headers } = await userAuth(app, "review-user-3");
  const fp = await seedPendingFootprint(user.id, place.id, { publicRequestedAt: "2026-05-01T08:00:00.000Z" });

  await app.inject({
    method: "POST", url: `/admin/review/${fp.id}`, headers: ADMIN_AUTH,
    payload: { action: "approve" },
  });

  const res = await app.inject({ method: "GET", url: `/stories/${fp.id}`, headers });
  expect(res.statusCode).toBe(200);
  expect(res.json().footprintId).toBe(fp.id);
});

test("reject → reviewStatus=REJECTED", async () => {
  const place = await seedPlace();
  const { user } = await userAuth(app, "review-user-4");
  const fp = await seedPendingFootprint(user.id, place.id, { publicRequestedAt: "2026-05-01T08:00:00.000Z" });

  const res = await app.inject({
    method: "POST", url: `/admin/review/${fp.id}`, headers: ADMIN_AUTH,
    payload: { action: "reject" },
  });
  expect(res.statusCode).toBe(204);

  const stored = await app.prisma.footprint.findUniqueOrThrow({ where: { id: fp.id } });
  expect(stored.reviewStatus).toBe("REJECTED");
});

test("对已 APPROVED 的足迹再审 → 409 not_pending", async () => {
  const place = await seedPlace();
  const { user } = await userAuth(app, "review-user-5");
  const fp = await seedPendingFootprint(user.id, place.id, { publicRequestedAt: "2026-05-01T08:00:00.000Z" });

  await app.inject({
    method: "POST", url: `/admin/review/${fp.id}`, headers: ADMIN_AUTH,
    payload: { action: "approve" },
  });

  const res = await app.inject({
    method: "POST", url: `/admin/review/${fp.id}`, headers: ADMIN_AUTH,
    payload: { action: "reject" },
  });
  expect(res.statusCode).toBe(409);
  expect(res.json().error).toBe("not_pending");
});

test("对 PRIVATE 足迹审核 → 409 not_pending（即便 reviewStatus 默认 PENDING）", async () => {
  const place = await seedPlace();
  const { user } = await userAuth(app, "review-user-6");
  const fp = await app.prisma.footprint.create({
    data: {
      userId: user.id, placeId: place.id, text: "私密",
      date: new Date("2026-05-01T10:00:00.000Z"), visibility: "PRIVATE",
    },
  });

  const res = await app.inject({
    method: "POST", url: `/admin/review/${fp.id}`, headers: ADMIN_AUTH,
    payload: { action: "approve" },
  });
  expect(res.statusCode).toBe(409);
  expect(res.json().error).toBe("not_pending");
});

test("未知 footprintId → 404", async () => {
  const res = await app.inject({
    method: "POST", url: "/admin/review/nope", headers: ADMIN_AUTH,
    payload: { action: "approve" },
  });
  expect(res.statusCode).toBe(404);
});

test("review 无 admin token → 401", async () => {
  const place = await seedPlace();
  const { user } = await userAuth(app, "review-user-7");
  const fp = await seedPendingFootprint(user.id, place.id, { publicRequestedAt: "2026-05-01T08:00:00.000Z" });

  const res = await app.inject({
    method: "POST", url: `/admin/review/${fp.id}`,
    payload: { action: "approve" },
  });
  expect(res.statusCode).toBe(401);
});

test("action 非法值 → 400 invalid_body", async () => {
  const place = await seedPlace();
  const { user } = await userAuth(app, "review-user-8");
  const fp = await seedPendingFootprint(user.id, place.id, { publicRequestedAt: "2026-05-01T08:00:00.000Z" });

  const res = await app.inject({
    method: "POST", url: `/admin/review/${fp.id}`, headers: ADMIN_AUTH,
    payload: { action: "delete" },
  });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toBe("invalid_body");
});

// ---------- GET /admin/reports & PATCH /admin/reports/:id ----------

async function createReport(cardId: string, userId: string, text = "有问题") {
  return app.prisma.cardReport.create({ data: { cardId, userId, text } });
}

test("GET /admin/reports 默认 status=OPEN，含 cardTitle", async () => {
  const place = await seedPlace();
  const card = await seedCard(place.id, "银锭观山");
  const { user } = await userAuth(app, "reporter-1");
  const report = await createReport(card.id, user.id, "地名写错了");

  const res = await app.inject({ method: "GET", url: "/admin/reports", headers: ADMIN_AUTH });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.items).toHaveLength(1);
  expect(body.items[0]).toMatchObject({
    id: report.id,
    cardId: card.id,
    cardTitle: "银锭观山",
    text: "地名写错了",
    status: "OPEN",
  });
  expect(body.items[0].createdAt).toBeTruthy();
});

test("GET /admin/reports?status=RESOLVED 只返回已处理", async () => {
  const place = await seedPlace();
  const card = await seedCard(place.id);
  const { user } = await userAuth(app, "reporter-2");
  const openReport = await createReport(card.id, user.id, "待处理的");
  const resolvedReport = await createReport(card.id, user.id, "已处理的");
  await app.prisma.cardReport.update({ where: { id: resolvedReport.id }, data: { status: "RESOLVED" } });

  const openRes = await app.inject({ method: "GET", url: "/admin/reports?status=OPEN", headers: ADMIN_AUTH });
  expect(openRes.json().items.map((i: { id: string }) => i.id)).toEqual([openReport.id]);

  const resolvedRes = await app.inject({
    method: "GET", url: "/admin/reports?status=RESOLVED", headers: ADMIN_AUTH,
  });
  expect(resolvedRes.json().items.map((i: { id: string }) => i.id)).toEqual([resolvedReport.id]);
});

test("PATCH /admin/reports/:id 标记 RESOLVED → 204，随后从 OPEN 列表消失", async () => {
  const place = await seedPlace();
  const card = await seedCard(place.id);
  const { user } = await userAuth(app, "reporter-3");
  const report = await createReport(card.id, user.id);

  const patchRes = await app.inject({
    method: "PATCH", url: `/admin/reports/${report.id}`, headers: ADMIN_AUTH,
    payload: { status: "RESOLVED" },
  });
  expect(patchRes.statusCode).toBe(204);

  const stored = await app.prisma.cardReport.findUniqueOrThrow({ where: { id: report.id } });
  expect(stored.status).toBe("RESOLVED");

  const openRes = await app.inject({ method: "GET", url: "/admin/reports", headers: ADMIN_AUTH });
  expect(openRes.json().items).toHaveLength(0);
});

test("PATCH /admin/reports/:id 未知 id → 404", async () => {
  const res = await app.inject({
    method: "PATCH", url: "/admin/reports/nope", headers: ADMIN_AUTH,
    payload: { status: "RESOLVED" },
  });
  expect(res.statusCode).toBe(404);
});

test("reports 端点无 admin token → 401", async () => {
  const getRes = await app.inject({ method: "GET", url: "/admin/reports" });
  expect(getRes.statusCode).toBe(401);

  const patchRes = await app.inject({
    method: "PATCH", url: "/admin/reports/whatever",
    payload: { status: "RESOLVED" },
  });
  expect(patchRes.statusCode).toBe(401);
});
