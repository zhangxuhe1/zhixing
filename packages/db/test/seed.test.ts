import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { createPrisma } from "../src/index.js";
import { createRng } from "../src/seed/rng.js";
import {
  NoPlacesError,
  createSeedStorage,
  photoObjectKey,
  planRich,
  planSparse,
  runCli,
  seedProfile,
  wipeSeedData,
  type PlaceLite,
  type S3Config,
} from "../src/seed/index.js";

const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://zhixing:zhixing@localhost:5433/zhixing_test";
const TEST_S3: S3Config = {
  endpoint: "http://localhost:9000",
  region: "us-east-1",
  bucket: "zhixing-test",
  accessKey: "zhixing",
  secretKey: "zhixing-secret",
};

const prisma = createPrisma(TEST_DB_URL);
const storage = createSeedStorage(TEST_S3);
const rawS3 = new S3Client({
  endpoint: TEST_S3.endpoint,
  region: TEST_S3.region,
  forcePathStyle: true,
  credentials: { accessKeyId: TEST_S3.accessKey, secretAccessKey: TEST_S3.secretKey },
});

beforeAll(() => storage.ensureBucket());
afterAll(() => prisma.$disconnect());

async function resetDb() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Like","CardFavorite","CardReport","FootprintPhoto","Footprint","Trip","CardBlock","Card","Place","User","SearchMiss" RESTART IDENTITY CASCADE',
  );
}
beforeEach(resetDb);

/** 造 6 个地点（2 城市 + 各自 2 个下辖点位），给 rich 的常驻/异地划分和 sparse 的"集中 2 地点"提供够用的素材。 */
async function seedPlaces() {
  const beijing = await prisma.place.create({ data: { name: "北京市", level: "CITY", lat: 39.9, lng: 116.4 } });
  const jinan = await prisma.place.create({ data: { name: "济南市", level: "CITY", lat: 36.65, lng: 117.12 } });
  const shichahai = await prisma.place.create({
    data: { name: "什刹海", level: "DISTRICT", parentId: beijing.id, lat: 39.94, lng: 116.38 },
  });
  const wudaokou = await prisma.place.create({
    data: { name: "五道口", level: "DISTRICT", parentId: beijing.id, lat: 39.99, lng: 116.34 },
  });
  const daminghu = await prisma.place.create({
    data: { name: "大明湖", level: "DISTRICT", parentId: jinan.id, lat: 36.68, lng: 117.02 },
  });
  const baotuquan = await prisma.place.create({
    data: { name: "趵突泉", level: "DISTRICT", parentId: jinan.id, lat: 36.67, lng: 117.0 },
  });
  return [beijing, jinan, shichahai, wudaokou, daminghu, baotuquan];
}

// ---------------------------------------------------------------------------
// 纯规划函数单测：不碰 DB/网络，验证契约中最容易出错的部分——数量区间、
// likeCount 一致性、点赞判据、对象键形状，以及"同 seed 同输入 → 逐字节相同"。
// ---------------------------------------------------------------------------

function fixturePlaces(): PlaceLite[] {
  return [
    { id: "p1", name: "什刹海", lat: 39.94, lng: 116.38 },
    { id: "p2", name: "五道口", lat: 39.99, lng: 116.34 },
    { id: "p3", name: "大明湖", lat: 36.68, lng: 117.02 },
    { id: "p4", name: "趵突泉", lat: 36.67, lng: 117.0 },
    { id: "p5", name: "西湖", lat: 30.25, lng: 120.15 },
    { id: "p6", name: "外滩", lat: 31.24, lng: 121.49 },
  ];
}

const OBJECT_KEY_RE = /^photos\/seed-fp-\d+-\d+\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$/;

test("规划确定性：同一 seed 对同一份 Place 数据两次运行产出逐字节相同的计划（rich）", () => {
  const places = fixturePlaces();
  const planA = planRich(createRng(42), places);
  const planB = planRich(createRng(42), places);
  expect(planB).toEqual(planA);
});

test("规划确定性：sparse 同理", () => {
  const places = fixturePlaces();
  const planA = planSparse(createRng(42), places);
  const planB = planSparse(createRng(42), places);
  expect(planB).toEqual(planA);
});

test("rich 规划契约：30 用户、每人 5-25 条；likeCount 与 Like 计划行一致，只发生在 PUBLIC+APPROVED 且不自赞；照片对象键形状正确", () => {
  const plan = planRich(createRng(42), fixturePlaces());
  expect(plan.users).toHaveLength(30);

  const countByUser = new Map<string, number>();
  for (const f of plan.footprints) countByUser.set(f.userId, (countByUser.get(f.userId) ?? 0) + 1);
  expect(countByUser.size).toBe(30);
  for (const count of countByUser.values()) {
    expect(count).toBeGreaterThanOrEqual(5);
    expect(count).toBeLessThanOrEqual(25);
  }

  const likeCountByFootprint = new Map<string, number>();
  for (const l of plan.likes) {
    likeCountByFootprint.set(l.footprintId, (likeCountByFootprint.get(l.footprintId) ?? 0) + 1);
  }
  const footprintById = new Map(plan.footprints.map((f) => [f.id, f]));
  for (const f of plan.footprints) {
    expect(f.likeCount).toBe(likeCountByFootprint.get(f.id) ?? 0);
  }
  expect(plan.likes.length).toBeGreaterThan(0); // 固定 seed 下应至少产生一些点赞，否则下面的断言是空判定
  for (const l of plan.likes) {
    const fp = footprintById.get(l.footprintId)!;
    expect(fp.visibility).toBe("PUBLIC");
    expect(fp.reviewStatus).toBe("APPROVED");
    expect(l.userId).not.toBe(fp.userId); // 不自赞
  }

  expect(plan.photos.length).toBeGreaterThan(0);
  for (const p of plan.photos) {
    expect(photoObjectKey(p.footprintId, p.uuid)).toMatch(OBJECT_KEY_RE);
  }
});

test("sparse 规划契约：3 用户合计 10 条、全部 PUBLIC+APPROVED、集中 2 个地点", () => {
  const plan = planSparse(createRng(42), fixturePlaces());
  expect(plan.users).toHaveLength(3);
  expect(plan.footprints).toHaveLength(10);
  expect(plan.footprints.every((f) => f.visibility === "PUBLIC" && f.reviewStatus === "APPROVED")).toBe(true);
  expect(new Set(plan.footprints.map((f) => f.placeId)).size).toBe(2);
});

// ---------------------------------------------------------------------------
// 端到端（真实 Postgres + 真实 MinIO）
// ---------------------------------------------------------------------------

test("sparse：3 用户 + 10 条 PUBLIC+APPROVED 足迹集中在 2 个地点，照片对象已写入 MinIO", async () => {
  await seedPlaces();
  const stats = await seedProfile(prisma, storage, "sparse");
  expect(stats.users).toBe(3);
  expect(stats.footprints).toBe(10);

  const users = await prisma.user.findMany({ where: { appleSub: { startsWith: "seed-" } } });
  expect(users).toHaveLength(3);

  const footprints = await prisma.footprint.findMany({ where: { userId: { in: users.map((u) => u.id) } } });
  expect(footprints).toHaveLength(10);
  expect(footprints.every((f) => f.visibility === "PUBLIC" && f.reviewStatus === "APPROVED")).toBe(true);
  expect(new Set(footprints.map((f) => f.placeId)).size).toBe(2);

  const photos = await prisma.footprintPhoto.findMany({
    where: { footprintId: { in: footprints.map((f) => f.id) } },
  });
  expect(photos.length).toBeGreaterThan(0);
  for (const photo of photos) {
    await expect(
      rawS3.send(new HeadObjectCommand({ Bucket: TEST_S3.bucket, Key: photo.mediaUrl })),
    ).resolves.toBeDefined();
  }
});

test("wipe：只清 seed- 前缀数据，非 seed 用户及其足迹/照片安然无恙", async () => {
  const places = await seedPlaces();
  const real = await prisma.user.create({ data: { appleSub: "real-user-1", nickname: "真实用户" } });
  const realFootprint = await prisma.footprint.create({
    data: {
      userId: real.id,
      placeId: places[0].id,
      date: new Date("2026-01-01T02:00:00.000Z"),
      visibility: "PUBLIC",
      reviewStatus: "APPROVED",
    },
  });
  const realKey = "photos/real/keep.jpg";
  await storage.put(realKey, Buffer.from("keep-me"), "image/jpeg");
  const realPhoto = await prisma.footprintPhoto.create({
    data: { footprintId: realFootprint.id, mediaUrl: realKey },
  });

  await seedProfile(prisma, storage, "sparse"); // 制造 seed 数据，验证 wipe 不会连坐

  const wiped = await wipeSeedData(prisma, storage);
  expect(wiped.users).toBe(3);
  expect(await prisma.user.count({ where: { appleSub: { startsWith: "seed-" } } })).toBe(0);

  expect(await prisma.user.findUnique({ where: { id: real.id } })).not.toBeNull();
  expect(await prisma.footprint.findUnique({ where: { id: realFootprint.id } })).not.toBeNull();
  expect(await prisma.footprintPhoto.findUnique({ where: { id: realPhoto.id } })).not.toBeNull();
  await expect(
    rawS3.send(new HeadObjectCommand({ Bucket: TEST_S3.bucket, Key: realKey })),
  ).resolves.toBeDefined();

  await storage.remove([realKey]);
});

test("幂等且确定性：重复 seed 同一 profile 数量不翻倍，footprintId 与照片对象键逐次相同", async () => {
  await seedPlaces();
  await seedProfile(prisma, storage, "sparse");
  const firstFootprintIds = (await prisma.footprint.findMany({ orderBy: { id: "asc" }, select: { id: true } })).map(
    (f) => f.id,
  );
  const firstPhotoKeys = (
    await prisma.footprintPhoto.findMany({ orderBy: { id: "asc" }, select: { mediaUrl: true } })
  ).map((p) => p.mediaUrl);
  expect(firstPhotoKeys.length).toBeGreaterThan(0);

  await seedProfile(prisma, storage, "sparse"); // 二次运行：不显式 wipe，内部隐式先清后种

  expect(await prisma.user.count({ where: { appleSub: { startsWith: "seed-" } } })).toBe(3);
  const secondFootprintIds = (await prisma.footprint.findMany({ orderBy: { id: "asc" }, select: { id: true } })).map(
    (f) => f.id,
  );
  const secondPhotoKeys = (
    await prisma.footprintPhoto.findMany({ orderBy: { id: "asc" }, select: { mediaUrl: true } })
  ).map((p) => p.mediaUrl);

  expect(secondFootprintIds).toHaveLength(10); // 不翻倍
  expect(secondFootprintIds).toEqual(firstFootprintIds); // 逐一相同（确定性）
  expect(secondPhotoKeys).toEqual(firstPhotoKeys);
});

test("无 Place 时 seedProfile 直接抛 NoPlacesError", async () => {
  await expect(seedProfile(prisma, storage, "sparse")).rejects.toBeInstanceOf(NoPlacesError);
});

test("无 Place 时 CLI 退出码 1，并给出内容导入提示", async () => {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const code = await runCli(["--profile", "sparse"], { databaseUrl: TEST_DB_URL, s3: TEST_S3 });
    expect(code).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
    const message = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(message).toMatch(/import-places|Place/);
  } finally {
    errorSpy.mockRestore();
  }
});

test(
  "rich：落库后统计口径与规划一致，抽样的照片对象与 likeCount 在真实 DB/MinIO 中站得住",
  async () => {
    await seedPlaces();
    const stats = await seedProfile(prisma, storage, "rich");
    expect(stats.users).toBe(30);

    const [userCount, footprintCount, photoCount, likeCount] = await Promise.all([
      prisma.user.count({ where: { appleSub: { startsWith: "seed-" } } }),
      prisma.footprint.count(),
      prisma.footprintPhoto.count(),
      prisma.like.count(),
    ]);
    expect(userCount).toBe(stats.users);
    expect(footprintCount).toBe(stats.footprints);
    expect(photoCount).toBe(stats.photos);
    expect(likeCount).toBe(stats.likes);

    const likedFootprint = await prisma.footprint.findFirst({ where: { likeCount: { gt: 0 } } });
    expect(likedFootprint).not.toBeNull();
    if (likedFootprint) {
      const actualLikes = await prisma.like.count({ where: { footprintId: likedFootprint.id } });
      expect(likedFootprint.likeCount).toBe(actualLikes);
    }

    const samplePhoto = await prisma.footprintPhoto.findFirst();
    expect(samplePhoto).not.toBeNull();
    if (samplePhoto) {
      await expect(
        rawS3.send(new HeadObjectCommand({ Bucket: TEST_S3.bucket, Key: samplePhoto.mediaUrl })),
      ).resolves.toBeDefined();
    }
  },
  30000,
);
