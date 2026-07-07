import { afterAll, beforeEach, expect, test } from "vitest";
import { resetDb, testApp, userAuth } from "./helpers.js";

const app = testApp();
beforeEach(() => resetDb(app));
afterAll(async () => app.close());

async function seedPlace() {
  return app.prisma.place.create({
    data: { name: "什刹海", level: "DISTRICT", lat: 39.94, lng: 116.38 },
  });
}

/** 直接写库造指定 visibility/reviewStatus 的足迹（绕开状态机） */
async function seedFootprint(opts: {
  placeId: string;
  userId: string;
  visibility: "PRIVATE" | "PUBLIC";
  reviewStatus: "PENDING" | "APPROVED" | "REJECTED";
}) {
  return app.prisma.footprint.create({
    data: {
      placeId: opts.placeId,
      userId: opts.userId,
      visibility: opts.visibility,
      reviewStatus: opts.reviewStatus,
      date: new Date("2026-01-01T10:00:00.000Z"),
      text: "一段旅人手记",
    },
  });
}

test("点亮幂等：同用户连续 PUT ×3 → likeCount=1", async () => {
  const place = await seedPlace();
  const author = await userAuth(app, "author1");
  const viewer = await userAuth(app, "viewer1");
  const fp = await seedFootprint({ placeId: place.id, userId: author.user.id, visibility: "PUBLIC", reviewStatus: "APPROVED" });

  for (let i = 0; i < 3; i++) {
    const res = await app.inject({ method: "PUT", url: `/footprints/${fp.id}/like`, headers: viewer.headers });
    expect(res.statusCode).toBe(204);
  }

  const updated = await app.prisma.footprint.findUniqueOrThrow({ where: { id: fp.id } });
  expect(updated.likeCount).toBe(1);
  expect(await app.prisma.like.count({ where: { footprintId: fp.id } })).toBe(1);
});

test("并发点亮：同用户 10 次并发 PUT → likeCount=1；10 个不同用户并发 PUT → likeCount=10", async () => {
  const place = await seedPlace();
  const author = await userAuth(app, "author2");
  const viewer = await userAuth(app, "viewer2");
  const fp = await seedFootprint({ placeId: place.id, userId: author.user.id, visibility: "PUBLIC", reviewStatus: "APPROVED" });

  const sameUserResults = await Promise.all(
    Array.from({ length: 10 }, () => app.inject({ method: "PUT", url: `/footprints/${fp.id}/like`, headers: viewer.headers })),
  );
  for (const res of sameUserResults) expect(res.statusCode).toBe(204);
  const afterSameUser = await app.prisma.footprint.findUniqueOrThrow({ where: { id: fp.id } });
  expect(afterSameUser.likeCount).toBe(1);

  const fp2 = await seedFootprint({ placeId: place.id, userId: author.user.id, visibility: "PUBLIC", reviewStatus: "APPROVED" });
  const distinctUsers = await Promise.all(
    Array.from({ length: 10 }, (_, i) => userAuth(app, `concurrent-user-${i}`)),
  );
  const distinctUserResults = await Promise.all(
    distinctUsers.map((u) => app.inject({ method: "PUT", url: `/footprints/${fp2.id}/like`, headers: u.headers })),
  );
  for (const res of distinctUserResults) expect(res.statusCode).toBe(204);
  const afterDistinctUsers = await app.prisma.footprint.findUniqueOrThrow({ where: { id: fp2.id } });
  expect(afterDistinctUsers.likeCount).toBe(10);
});

test("取消点亮：PUT→DELETE→likeCount=0；再次 DELETE 仍 204 且 likeCount=0", async () => {
  const place = await seedPlace();
  const author = await userAuth(app, "author3");
  const viewer = await userAuth(app, "viewer3");
  const fp = await seedFootprint({ placeId: place.id, userId: author.user.id, visibility: "PUBLIC", reviewStatus: "APPROVED" });

  const putRes = await app.inject({ method: "PUT", url: `/footprints/${fp.id}/like`, headers: viewer.headers });
  expect(putRes.statusCode).toBe(204);

  const delRes = await app.inject({ method: "DELETE", url: `/footprints/${fp.id}/like`, headers: viewer.headers });
  expect(delRes.statusCode).toBe(204);
  let updated = await app.prisma.footprint.findUniqueOrThrow({ where: { id: fp.id } });
  expect(updated.likeCount).toBe(0);

  const delAgainRes = await app.inject({ method: "DELETE", url: `/footprints/${fp.id}/like`, headers: viewer.headers });
  expect(delAgainRes.statusCode).toBe(204);
  updated = await app.prisma.footprint.findUniqueOrThrow({ where: { id: fp.id } });
  expect(updated.likeCount).toBe(0);
});

test("目标校验：对非公开可见（PENDING）足迹 PUT like → 404；POST view 同样 404", async () => {
  const place = await seedPlace();
  const author = await userAuth(app, "author4");
  const viewer = await userAuth(app, "viewer4");
  const fp = await seedFootprint({ placeId: place.id, userId: author.user.id, visibility: "PUBLIC", reviewStatus: "PENDING" });

  const likeRes = await app.inject({ method: "PUT", url: `/footprints/${fp.id}/like`, headers: viewer.headers });
  expect(likeRes.statusCode).toBe(404);

  const unlikeRes = await app.inject({ method: "DELETE", url: `/footprints/${fp.id}/like`, headers: viewer.headers });
  expect(unlikeRes.statusCode).toBe(404);

  const viewRes = await app.inject({ method: "POST", url: `/footprints/${fp.id}/view`, headers: viewer.headers });
  expect(viewRes.statusCode).toBe(404);
});

test("目标不存在 → 404", async () => {
  const { headers } = await userAuth(app, "viewer5");
  const likeRes = await app.inject({ method: "PUT", url: "/footprints/nope/like", headers });
  expect(likeRes.statusCode).toBe(404);
  const viewRes = await app.inject({ method: "POST", url: "/footprints/nope/view", headers });
  expect(viewRes.statusCode).toBe(404);
});

test("属主对自己的可见足迹操作同样允许", async () => {
  const place = await seedPlace();
  const author = await userAuth(app, "author6");
  const fp = await seedFootprint({ placeId: place.id, userId: author.user.id, visibility: "PUBLIC", reviewStatus: "APPROVED" });

  const likeRes = await app.inject({ method: "PUT", url: `/footprints/${fp.id}/like`, headers: author.headers });
  expect(likeRes.statusCode).toBe(204);
  const viewRes = await app.inject({ method: "POST", url: `/footprints/${fp.id}/view`, headers: author.headers });
  expect(viewRes.statusCode).toBe(204);
});

test("浏览计数：POST ×3 → viewCount=3，无去重", async () => {
  const place = await seedPlace();
  const author = await userAuth(app, "author7");
  const viewer = await userAuth(app, "viewer7");
  const fp = await seedFootprint({ placeId: place.id, userId: author.user.id, visibility: "PUBLIC", reviewStatus: "APPROVED" });

  for (let i = 0; i < 3; i++) {
    const res = await app.inject({ method: "POST", url: `/footprints/${fp.id}/view`, headers: viewer.headers });
    expect(res.statusCode).toBe(204);
  }

  const updated = await app.prisma.footprint.findUniqueOrThrow({ where: { id: fp.id } });
  expect(updated.viewCount).toBe(3);
});

test("未登录访问三端点 → 401", async () => {
  const place = await seedPlace();
  const author = await userAuth(app, "author8");
  const fp = await seedFootprint({ placeId: place.id, userId: author.user.id, visibility: "PUBLIC", reviewStatus: "APPROVED" });

  const putRes = await app.inject({ method: "PUT", url: `/footprints/${fp.id}/like` });
  expect(putRes.statusCode).toBe(401);
  const delRes = await app.inject({ method: "DELETE", url: `/footprints/${fp.id}/like` });
  expect(delRes.statusCode).toBe(401);
  const viewRes = await app.inject({ method: "POST", url: `/footprints/${fp.id}/view` });
  expect(viewRes.statusCode).toBe(401);
});
