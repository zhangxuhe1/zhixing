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

/** 直接写库造指定 visibility/reviewStatus 的足迹（绕开状态机，测试可见性判据用） */
async function seedFootprint(opts: {
  placeId: string;
  userId: string;
  visibility: "PRIVATE" | "PUBLIC";
  reviewStatus: "PENDING" | "APPROVED" | "REJECTED";
  date: string;
  text?: string | null;
}) {
  return app.prisma.footprint.create({
    data: {
      placeId: opts.placeId,
      userId: opts.userId,
      visibility: opts.visibility,
      reviewStatus: opts.reviewStatus,
      date: new Date(opts.date),
      text: opts.text ?? "一段旅人手记",
    },
  });
}

test("匿名访问三个公开读端点 → 一律 401（公开=登录可见，无匿名访问面）", async () => {
  const place = await seedPlace();
  const { user } = await userAuth(app, "author0");
  const fp = await seedFootprint({ placeId: place.id, userId: user.id, visibility: "PUBLIC", reviewStatus: "APPROVED", date: "2026-01-01T10:00:00.000Z" });

  for (const url of [
    `/places/${place.id}/stories`,
    `/places/${place.id}/photo-wall`,
    `/stories/${fp.id}`,
  ]) {
    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("unauthorized");
  }
});

test("可见性矩阵：同地点四种状态，stories 只含 PUBLIC+APPROVED", async () => {
  const place = await seedPlace();
  const { user } = await userAuth(app, "author");
  const viewer = await userAuth(app, "viewer");

  await seedFootprint({ placeId: place.id, userId: user.id, visibility: "PRIVATE", reviewStatus: "APPROVED", date: "2026-01-01T10:00:00.000Z", text: "私密的" });
  await seedFootprint({ placeId: place.id, userId: user.id, visibility: "PUBLIC", reviewStatus: "PENDING", date: "2026-01-02T10:00:00.000Z", text: "待审的" });
  await seedFootprint({ placeId: place.id, userId: user.id, visibility: "PUBLIC", reviewStatus: "REJECTED", date: "2026-01-03T10:00:00.000Z", text: "被拒的" });
  const approved = await seedFootprint({ placeId: place.id, userId: user.id, visibility: "PUBLIC", reviewStatus: "APPROVED", date: "2026-01-04T10:00:00.000Z", text: "通过的" });

  const res = await app.inject({ method: "GET", url: `/places/${place.id}/stories`, headers: viewer.headers });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.items).toHaveLength(1);
  expect(body.items[0].footprintId).toBe(approved.id);
  expect(body.items[0].text).toBe("通过的");
});

test("防泄露回归：stories 响应不含禁字段子串", async () => {
  const place = await seedPlace();
  const { user } = await userAuth(app, "author2");
  const viewer = await userAuth(app, "viewer2");
  const fp = await seedFootprint({ placeId: place.id, userId: user.id, visibility: "PUBLIC", reviewStatus: "APPROVED", date: "2026-01-01T10:00:00.000Z" });
  await app.prisma.footprintPhoto.create({
    data: { footprintId: fp.id, mediaUrl: "photos/x.jpg", takenAt: new Date("2026-01-01T09:00:00.000Z"), lat: 39.94, lng: 116.38 },
  });

  const res = await app.inject({ method: "GET", url: `/places/${place.id}/stories`, headers: viewer.headers });
  expect(res.statusCode).toBe(200);
  expect(res.json().items).toHaveLength(1);
  const raw = JSON.stringify(res.json());
  for (const banned of ['"userId"', '"appleSub"', '"lat"', '"lng"', '"takenAt"', '"email"', '"subject"']) {
    expect(raw).not.toContain(banned);
  }
});

test("likedByMe：B 点过赞 → B 视角 true，C 视角 false", async () => {
  const place = await seedPlace();
  const author = await userAuth(app, "author3");
  const b = await userAuth(app, "bob");
  const c = await userAuth(app, "carol");
  const fp = await seedFootprint({ placeId: place.id, userId: author.user.id, visibility: "PUBLIC", reviewStatus: "APPROVED", date: "2026-01-01T10:00:00.000Z" });
  await app.prisma.like.create({ data: { userId: b.user.id, footprintId: fp.id } });

  const resB = await app.inject({ method: "GET", url: `/places/${place.id}/stories`, headers: b.headers });
  expect(resB.json().items[0].likedByMe).toBe(true);

  const resC = await app.inject({ method: "GET", url: `/places/${place.id}/stories`, headers: c.headers });
  expect(resC.json().items[0].likedByMe).toBe(false);
});

test("分页：25 条 APPROVED，limit=20 → nextCursor 非空，第二页 5 条且无重叠", async () => {
  const place = await seedPlace();
  const { user } = await userAuth(app, "author4");
  const viewer = await userAuth(app, "viewer4");
  const ids: string[] = [];
  for (let i = 0; i < 25; i++) {
    const fp = await seedFootprint({
      placeId: place.id, userId: user.id, visibility: "PUBLIC", reviewStatus: "APPROVED",
      date: new Date(2026, 0, i + 1).toISOString(),
    });
    ids.push(fp.id);
  }

  const page1 = await app.inject({
    method: "GET", url: `/places/${place.id}/stories?limit=20`, headers: viewer.headers,
  });
  expect(page1.statusCode).toBe(200);
  const body1 = page1.json();
  expect(body1.items).toHaveLength(20);
  expect(body1.nextCursor).not.toBeNull();

  const page2 = await app.inject({
    method: "GET", url: `/places/${place.id}/stories?limit=20&cursor=${body1.nextCursor}`,
    headers: viewer.headers,
  });
  const body2 = page2.json();
  expect(body2.items).toHaveLength(5);
  expect(body2.nextCursor).toBeNull();

  const ids1 = new Set(body1.items.map((i: { footprintId: string }) => i.footprintId));
  const ids2 = body2.items.map((i: { footprintId: string }) => i.footprintId);
  for (const id of ids2) expect(ids1.has(id)).toBe(false);
  expect(new Set([...ids1, ...ids2]).size).toBe(25);
});

test("photo-wall 分组：2024-04 与 2023-11 两条带照片足迹 → groups=[2024·春, 2023·秋] 顺序；组内照片按创建序", async () => {
  const place = await seedPlace();
  const { user } = await userAuth(app, "author5");
  const viewer = await userAuth(app, "viewer5");
  const spring = await seedFootprint({ placeId: place.id, userId: user.id, visibility: "PUBLIC", reviewStatus: "APPROVED", date: "2024-04-15T10:00:00.000Z" });
  const autumn = await seedFootprint({ placeId: place.id, userId: user.id, visibility: "PUBLIC", reviewStatus: "APPROVED", date: "2023-11-15T10:00:00.000Z" });
  // 同一足迹下两张照片：断言组内按创建序（springPhoto1 在前）。原实现是 id 倒序，
  // 与私密面/故事面顺序相反——spec §0 的有意修复，orderIndex 相同（存量 0）时 id 升序兜底。
  const springPhoto1 = await app.prisma.footprintPhoto.create({ data: { footprintId: spring.id, mediaUrl: "photos/s1.jpg" } });
  const springPhoto2 = await app.prisma.footprintPhoto.create({ data: { footprintId: spring.id, mediaUrl: "photos/s2.jpg" } });
  const photoAutumn = await app.prisma.footprintPhoto.create({ data: { footprintId: autumn.id, mediaUrl: "photos/a.jpg" } });

  const res = await app.inject({ method: "GET", url: `/places/${place.id}/photo-wall`, headers: viewer.headers });
  expect(res.statusCode).toBe(200);
  const body = res.json();
  expect(body.groups.map((g: { label: string }) => g.label)).toEqual(["2024·春", "2023·秋"]);

  expect(body.groups[0].photos).toEqual(
    [springPhoto1.id, springPhoto2.id].map((id) => ({ photoId: id, footprintId: spring.id })),
  );
  expect(body.groups[1].photos).toEqual([{ photoId: photoAutumn.id, footprintId: autumn.id }]);
  // 护栏：不带计数字段
  expect(JSON.stringify(body)).not.toContain("count");
});

test("photo-wall 冬季分支：12 月足迹 → label 为当年·冬（不跨年）", async () => {
  const place = await seedPlace();
  const { user } = await userAuth(app, "author7");
  const viewer = await userAuth(app, "viewer7");
  const winter = await seedFootprint({ placeId: place.id, userId: user.id, visibility: "PUBLIC", reviewStatus: "APPROVED", date: "2024-12-15T10:00:00.000Z" });
  await app.prisma.footprintPhoto.create({ data: { footprintId: winter.id, mediaUrl: "photos/w.jpg" } });

  const res = await app.inject({ method: "GET", url: `/places/${place.id}/photo-wall`, headers: viewer.headers });
  expect(res.statusCode).toBe(200);
  expect(res.json().groups.map((g: { label: string }) => g.label)).toEqual(["2024·冬"]);
});

test("单条 story：APPROVED → 200 形状完整；PENDING → 404", async () => {
  const place = await seedPlace();
  const { user } = await userAuth(app, "author6");
  const viewer = await userAuth(app, "viewer6");
  const approved = await seedFootprint({ placeId: place.id, userId: user.id, visibility: "PUBLIC", reviewStatus: "APPROVED", date: "2026-01-01T10:00:00.000Z", text: "完整故事" });
  const photo = await app.prisma.footprintPhoto.create({ data: { footprintId: approved.id, mediaUrl: "photos/y.jpg" } });
  const pending = await seedFootprint({ placeId: place.id, userId: user.id, visibility: "PUBLIC", reviewStatus: "PENDING", date: "2026-01-02T10:00:00.000Z" });

  const okRes = await app.inject({ method: "GET", url: `/stories/${approved.id}`, headers: viewer.headers });
  expect(okRes.statusCode).toBe(200);
  expect(okRes.json()).toEqual({
    footprintId: approved.id,
    text: "完整故事",
    date: "2026-01-01T10:00:00.000Z",
    authorNickname: user.nickname,
    likeCount: 0,
    viewCount: 0,
    likedByMe: false,
    photos: [{ photoId: photo.id }],
  });

  const pendingRes = await app.inject({ method: "GET", url: `/stories/${pending.id}`, headers: viewer.headers });
  expect(pendingRes.statusCode).toBe(404);
});

test("地点不存在 → stories 404", async () => {
  const { headers } = await userAuth(app, "viewer8");
  const res = await app.inject({ method: "GET", url: "/places/nope/stories", headers });
  expect(res.statusCode).toBe(404);
});

test("I3：拿私密足迹 id 当游标 → 与无游标响应完全一致（无存在性/日期 oracle）", async () => {
  const place = await seedPlace();
  const { user } = await userAuth(app, "authorI3");
  const viewer = await userAuth(app, "viewerI3");

  // 本地点两条 APPROVED 公开故事。
  await seedFootprint({ placeId: place.id, userId: user.id, visibility: "PUBLIC", reviewStatus: "APPROVED", date: "2026-01-01T10:00:00.000Z", text: "公开一" });
  await seedFootprint({ placeId: place.id, userId: user.id, visibility: "PUBLIC", reviewStatus: "APPROVED", date: "2026-01-02T10:00:00.000Z", text: "公开二" });
  // 一条撤回的私密足迹（同地点），其 id 不应可作探测游标。
  const secret = await seedFootprint({ placeId: place.id, userId: user.id, visibility: "PRIVATE", reviewStatus: "APPROVED", date: "2026-06-01T10:00:00.000Z", text: "私密" });

  const noCursor = await app.inject({
    method: "GET", url: `/places/${place.id}/stories`, headers: viewer.headers,
  });
  const withSecretCursor = await app.inject({
    method: "GET", url: `/places/${place.id}/stories?cursor=${secret.id}`, headers: viewer.headers,
  });
  expect(withSecretCursor.statusCode).toBe(noCursor.statusCode);
  // 逐字节一致：错游标被当作首页，无法据此区分该 id 是否存在或其日期。
  expect(withSecretCursor.json()).toEqual(noCursor.json());
});

test("I3：他地点的公开足迹 id 当游标 → 也退化为首页（游标须限定本地点）", async () => {
  const placeA = await seedPlace();
  const placeB = await app.prisma.place.create({
    data: { name: "另一地", level: "DISTRICT", lat: 5, lng: 5 },
  });
  const { user } = await userAuth(app, "authorI3b");
  const viewer = await userAuth(app, "viewerI3b");
  await seedFootprint({ placeId: placeA.id, userId: user.id, visibility: "PUBLIC", reviewStatus: "APPROVED", date: "2026-01-01T10:00:00.000Z", text: "A-公开" });
  const otherPlaceFp = await seedFootprint({ placeId: placeB.id, userId: user.id, visibility: "PUBLIC", reviewStatus: "APPROVED", date: "2026-03-01T10:00:00.000Z", text: "B-公开" });

  const noCursor = await app.inject({
    method: "GET", url: `/places/${placeA.id}/stories`, headers: viewer.headers,
  });
  const foreignCursor = await app.inject({
    method: "GET", url: `/places/${placeA.id}/stories?cursor=${otherPlaceFp.id}`, headers: viewer.headers,
  });
  expect(foreignCursor.json()).toEqual(noCursor.json());
});

test("M1：仅有纯文字（无照片）的公开足迹 → photo-wall 不产出空分组", async () => {
  const place = await seedPlace();
  const { user } = await userAuth(app, "authorM1");
  const viewer = await userAuth(app, "viewerM1");
  // 独占一个季度的纯文字 APPROVED 足迹（无照片）。
  await seedFootprint({ placeId: place.id, userId: user.id, visibility: "PUBLIC", reviewStatus: "APPROVED", date: "2024-04-15T10:00:00.000Z", text: "只有文字没有照片" });

  const res = await app.inject({ method: "GET", url: `/places/${place.id}/photo-wall`, headers: viewer.headers });
  expect(res.statusCode).toBe(200);
  expect(res.json().groups).toEqual([]);
});

test("M1：混合场景下只保留有照片的分组，纯文字季度不出现", async () => {
  const place = await seedPlace();
  const { user } = await userAuth(app, "authorM1b");
  const viewer = await userAuth(app, "viewerM1b");
  // 春季有照片；秋季纯文字。
  const spring = await seedFootprint({ placeId: place.id, userId: user.id, visibility: "PUBLIC", reviewStatus: "APPROVED", date: "2024-04-15T10:00:00.000Z" });
  await app.prisma.footprintPhoto.create({ data: { footprintId: spring.id, mediaUrl: "photos/m1.jpg" } });
  await seedFootprint({ placeId: place.id, userId: user.id, visibility: "PUBLIC", reviewStatus: "APPROVED", date: "2023-11-15T10:00:00.000Z", text: "秋季纯文字" });

  const res = await app.inject({ method: "GET", url: `/places/${place.id}/photo-wall`, headers: viewer.headers });
  expect(res.json().groups.map((g: { label: string }) => g.label)).toEqual(["2024·春"]);
});
