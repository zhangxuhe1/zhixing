/**
 * seed CLI 扩展能力测试：--with-cards（卡片状态多样化 + seed 用户收藏/举报）
 * 与 --with-dev-account（dev 账号个人数据：四种状态足迹、行程、未归组日期簇、照片、点赞、收藏）。
 *
 * 纯规划函数部分不碰 DB；端到端部分走真实 Postgres + MinIO（与 seed.test.ts 同款基建）。
 */
import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { createPrisma } from "../src/index.js";
import { createRng } from "../src/seed/rng.js";
import {
  createSeedStorage,
  planSparse,
  runCli,
  seedProfile,
  wipeSeedData,
  type PlaceLite,
  type S3Config,
} from "../src/seed/index.js";
import {
  DEV_APPLE_SUB,
  planCardOps,
  planDevAccount,
  planSeedEngagement,
  type CardLite,
} from "../src/seed/extras.js";

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
    'TRUNCATE TABLE "Like","CardFavorite","CardReport","FootprintPhoto","Footprint","Trip","CardBlock","Card","Place","User","Identity","SearchMiss" RESTART IDENTITY CASCADE',
  );
}
beforeEach(resetDb);

/** dev 账号经 (APPLE, simulator-dev) 身份反查——seed/登录已停止读写 user.appleSub。 */
async function findDevUser() {
  const identity = await prisma.identity.findUnique({
    where: { provider_subject: { provider: "APPLE", subject: DEV_APPLE_SUB } },
    include: { user: true },
  });
  return identity?.user ?? null;
}

// ---------------------------------------------------------------------------
// 纯规划函数：fixtures
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

/** 4 个地点 × 各 3 张卡，id 字典序即库内 orderBy id 的顺序。 */
function fixtureCards(): CardLite[] {
  const cards: CardLite[] = [];
  for (let p = 1; p <= 4; p++) {
    for (let c = 1; c <= 3; c++) {
      cards.push({ id: `card-p${p}-${c}`, placeId: `p${p}` });
    }
  }
  return cards;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const SIM_KEY_RE =
  /^photos\/sim-fp-\d+\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$/;

// ---------------------------------------------------------------------------
// planCardOps：状态多样化选择是"纯序"函数（只看顺序与地点分组，不看当前状态）
// ---------------------------------------------------------------------------

test("planCardOps：每 3 张取 1 张 REVIEWED；3 张 RETIRED 来自不同地点且该地点仍有存活卡；两个集合不重叠", () => {
  const cards = fixtureCards();
  const ops = planCardOps(cards);

  expect(ops.retiredIds).toHaveLength(3);
  // RETIRED 来自 3 个不同地点，且每个地点原有 >=3 张（下架 1 张后仍有可见卡）
  const cardById = new Map(cards.map((c) => [c.id, c]));
  const retiredPlaces = ops.retiredIds.map((id) => cardById.get(id)!.placeId);
  expect(new Set(retiredPlaces).size).toBe(3);

  // REVIEWED = 每 3 张取 1 张（index % 3 === 0），再剔除 RETIRED
  const expectedReviewed = cards
    .filter((_, i) => i % 3 === 0)
    .map((c) => c.id)
    .filter((id) => !ops.retiredIds.includes(id));
  expect(ops.reviewedIds).toEqual(expectedReviewed);
  for (const id of ops.reviewedIds) expect(ops.retiredIds).not.toContain(id);

  // 纯函数：同输入同输出
  expect(planCardOps(fixtureCards())).toEqual(ops);
});

test("planCardOps：没有任何地点凑满 3 张时不下架（优雅降级）", () => {
  const cards: CardLite[] = [
    { id: "c1", placeId: "p1" },
    { id: "c2", placeId: "p1" },
    { id: "c3", placeId: "p2" },
  ];
  const ops = planCardOps(cards);
  expect(ops.retiredIds).toHaveLength(0);
  expect(ops.reviewedIds).toEqual(["c1"]);
});

// ---------------------------------------------------------------------------
// planSeedEngagement：seed 用户的收藏与举报队列
// ---------------------------------------------------------------------------

test("planSeedEngagement：收藏不重复（userId,cardId 唯一）；举报最多 6 条、恰 1 条 RESOLVED、卡片不重复", () => {
  const cards = fixtureCards();
  const seedUserIds = ["seed-u1", "seed-u2", "seed-u3"];
  const plan = planSeedEngagement(createRng(42), cards, seedUserIds);

  expect(plan.favorites.length).toBeGreaterThan(0);
  const favKeys = plan.favorites.map((f) => `${f.userId}:${f.cardId}`);
  expect(new Set(favKeys).size).toBe(favKeys.length);
  for (const f of plan.favorites) {
    expect(f.id.startsWith("sim-")).toBe(true);
    expect(seedUserIds).toContain(f.userId);
  }

  expect(plan.reports).toHaveLength(6); // 12 张卡足够挑 6 张
  expect(new Set(plan.reports.map((r) => r.cardId)).size).toBe(6);
  expect(plan.reports.filter((r) => r.status === "RESOLVED")).toHaveLength(1);
  for (const r of plan.reports) {
    expect(r.id.startsWith("sim-")).toBe(true);
    expect(seedUserIds).toContain(r.userId);
    expect(r.text.length).toBeGreaterThan(0);
  }

  // 确定性
  expect(planSeedEngagement(createRng(42), fixtureCards(), seedUserIds)).toEqual(plan);
});

test("planSeedEngagement：没有 seed 用户时举报为空（举报必须有举报人）", () => {
  const plan = planSeedEngagement(createRng(42), fixtureCards(), []);
  expect(plan.reports).toHaveLength(0);
  expect(plan.favorites).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// planDevAccount：dev 账号个人数据
// ---------------------------------------------------------------------------

function makeDevPlan() {
  const places = fixturePlaces();
  const seedPlan = planSparse(createRng(42), places);
  return planDevAccount(createRng(7), {
    devUserId: "dev-user-1",
    places,
    seedUsers: seedPlan.users,
    seedFootprints: seedPlan.footprints,
    cards: fixtureCards(),
  });
}

test("planDevAccount：确定性——同 seed 同输入两次运行逐字节相同", () => {
  expect(makeDevPlan()).toEqual(makeDevPlan());
});

test("planDevAccount：足迹全部 sim- 前缀且属于 dev；四种可见性/审核状态组合齐备；PUBLIC 才有 publicRequestedAt", () => {
  const plan = makeDevPlan();
  expect(plan.footprints.length).toBeGreaterThan(0);
  for (const f of plan.footprints) {
    expect(f.id.startsWith("sim-fp-")).toBe(true);
    expect(f.userId).toBe("dev-user-1");
    expect(f.publicRequestedAt !== null).toBe(f.visibility === "PUBLIC");
  }
  const combos = new Set(plan.footprints.map((f) => `${f.visibility}:${f.reviewStatus}`));
  expect(combos.has("PUBLIC:APPROVED")).toBe(true);
  expect(combos.has("PUBLIC:PENDING")).toBe(true);
  expect(combos.has("PUBLIC:REJECTED")).toBe(true);
  expect(combos.has("PRIVATE:PENDING")).toBe(true);
});

test("planDevAccount：恰 2 段行程，各自足迹日期连续、同一地点，行程起止与足迹对齐", () => {
  const plan = makeDevPlan();
  expect(plan.trips).toHaveLength(2);
  for (const trip of plan.trips) {
    expect(trip.id.startsWith("sim-trip-")).toBe(true);
    const fps = plan.footprints
      .filter((f) => f.tripId === trip.id)
      .sort((a, b) => a.date.getTime() - b.date.getTime());
    expect(fps.length).toBeGreaterThanOrEqual(2);
    expect(new Set(fps.map((f) => f.placeId)).size).toBe(1);
    expect(fps[0].placeId).toBe(trip.placeId);
    for (let i = 1; i < fps.length; i++) {
      expect(fps[i].date.getTime() - fps[i - 1].date.getTime()).toBe(MS_PER_DAY);
    }
    expect(trip.startDate.getTime()).toBe(fps[0].date.getTime());
    expect(trip.endDate.getTime()).toBe(fps[fps.length - 1].date.getTime());
  }
});

test("planDevAccount：存在未归组的连续日期簇（tripId 为空、同地点、相邻 1 天），供 /me/trip-suggestions 演示", () => {
  const plan = makeDevPlan();
  const loose = plan.footprints
    .filter((f) => f.tripId === null)
    .sort((a, b) => a.date.getTime() - b.date.getTime());
  const hasCluster = loose.some((f, i) => {
    if (i === 0) return false;
    const prev = loose[i - 1];
    return f.placeId === prev.placeId && f.date.getTime() - prev.date.getTime() === MS_PER_DAY;
  });
  expect(hasCluster).toBe(true);
});

test("planDevAccount：照片对象键形状正确、行程足迹至少各 1 张照片；点赞与收藏契约", () => {
  const plan = makeDevPlan();
  const fpById = new Map(plan.footprints.map((f) => [f.id, f]));

  expect(plan.photos.length).toBeGreaterThan(0);
  for (const p of plan.photos) {
    expect(`photos/${p.footprintId}/${p.uuid}.jpg`).toMatch(SIM_KEY_RE);
    expect(fpById.has(p.footprintId)).toBe(true);
  }
  const photoCountByFp = new Map<string, number>();
  for (const p of plan.photos) {
    photoCountByFp.set(p.footprintId, (photoCountByFp.get(p.footprintId) ?? 0) + 1);
  }
  for (const f of plan.footprints.filter((f) => f.tripId !== null)) {
    expect(photoCountByFp.get(f.id) ?? 0).toBeGreaterThanOrEqual(1);
  }

  // likesIn：seed 用户点亮 dev 的 PUBLIC+APPROVED 足迹，likeCount 与行数一致，不重复
  const seedUserIds = new Set(planSparse(createRng(42), fixturePlaces()).users.map((u) => u.id));
  expect(plan.likesIn.length).toBeGreaterThan(0);
  const likeKeys = plan.likesIn.map((l) => `${l.userId}:${l.footprintId}`);
  expect(new Set(likeKeys).size).toBe(likeKeys.length);
  const inCountByFp = new Map<string, number>();
  for (const l of plan.likesIn) {
    expect(seedUserIds.has(l.userId)).toBe(true);
    const fp = fpById.get(l.footprintId)!;
    expect(fp.visibility).toBe("PUBLIC");
    expect(fp.reviewStatus).toBe("APPROVED");
    inCountByFp.set(l.footprintId, (inCountByFp.get(l.footprintId) ?? 0) + 1);
  }
  for (const f of plan.footprints) {
    expect(f.likeCount).toBe(inCountByFp.get(f.id) ?? 0);
  }

  // likesOut：dev 点赞 seed 计划中 PUBLIC+APPROVED 的足迹，最多 8 条、不重复
  const likable = new Set(
    planSparse(createRng(42), fixturePlaces())
      .footprints.filter((f) => f.visibility === "PUBLIC" && f.reviewStatus === "APPROVED")
      .map((f) => f.id),
  );
  expect(plan.likesOut.length).toBeGreaterThan(0);
  expect(plan.likesOut.length).toBeLessThanOrEqual(8);
  expect(new Set(plan.likesOut.map((l) => l.footprintId)).size).toBe(plan.likesOut.length);
  for (const l of plan.likesOut) {
    expect(l.userId).toBe("dev-user-1");
    expect(likable.has(l.footprintId)).toBe(true);
  }

  // dev 收藏：最多 8 张、卡片不重复
  expect(plan.favorites.length).toBeGreaterThan(0);
  expect(plan.favorites.length).toBeLessThanOrEqual(8);
  expect(new Set(plan.favorites.map((f) => f.cardId)).size).toBe(plan.favorites.length);
  for (const f of plan.favorites) expect(f.userId).toBe("dev-user-1");
});

// ---------------------------------------------------------------------------
// 端到端（真实 Postgres + MinIO）
// ---------------------------------------------------------------------------

async function seedPlacesAndCards() {
  const beijing = await prisma.place.create({ data: { name: "北京市", level: "CITY", lat: 39.9, lng: 116.4 } });
  const jinan = await prisma.place.create({ data: { name: "济南市", level: "CITY", lat: 36.65, lng: 117.12 } });
  const districts = await Promise.all(
    [
      { name: "什刹海", parentId: beijing.id, lat: 39.94, lng: 116.38 },
      { name: "五道口", parentId: beijing.id, lat: 39.99, lng: 116.34 },
      { name: "大明湖", parentId: jinan.id, lat: 36.68, lng: 117.02 },
      { name: "趵突泉", parentId: jinan.id, lat: 36.67, lng: 117.0 },
    ].map((d) => prisma.place.create({ data: { ...d, level: "DISTRICT" } })),
  );
  const places = [beijing, jinan, ...districts];
  // 前 4 个地点各 3 张卡（id 显式给定以保证 orderBy id 顺序稳定）
  for (let p = 0; p < 4; p++) {
    for (let c = 1; c <= 3; c++) {
      await prisma.card.create({
        data: {
          id: `card-${p + 1}-${c}`,
          placeId: places[p].id,
          category: "ANECDOTE",
          title: `${places[p].name}掌故${c}`,
          sources: [],
        },
      });
    }
  }
  return places;
}

test("端到端：--with-cards + --with-dev-account 一次种出卡片状态、举报队列、收藏与 dev 账号数据；照片真实写入 MinIO", async () => {
  await seedPlacesAndCards();
  const stats = await seedProfile(prisma, storage, "sparse", {
    withCards: true,
    withDevAccount: true,
  });
  expect(stats.users).toBe(3);

  // dev 用户被自动创建（(APPLE, simulator-dev) 身份与 API dev 登录一致，后续模拟器登录会复用）
  const dev = await findDevUser();
  expect(dev).not.toBeNull();

  // 卡片状态多样化
  expect(await prisma.card.count({ where: { status: "REVIEWED" } })).toBeGreaterThan(0);
  expect(await prisma.card.count({ where: { status: "RETIRED" } })).toBe(3);

  // 举报队列：5 OPEN + 1 RESOLVED
  expect(await prisma.cardReport.count({ where: { status: "OPEN" } })).toBe(5);
  expect(await prisma.cardReport.count({ where: { status: "RESOLVED" } })).toBe(1);

  // 收藏：dev + seed 用户都有，且不收藏 RETIRED 卡
  const favs = await prisma.cardFavorite.findMany({ include: { card: true } });
  expect(favs.length).toBeGreaterThan(0);
  expect(favs.some((f) => f.userId === dev!.id)).toBe(true);
  expect(favs.every((f) => f.card.status !== "RETIRED")).toBe(true);

  // dev 个人数据：足迹四种状态、2 段行程、照片在 MinIO
  const devFps = await prisma.footprint.findMany({ where: { userId: dev!.id } });
  expect(devFps.length).toBeGreaterThan(0);
  const combos = new Set(devFps.map((f) => `${f.visibility}:${f.reviewStatus}`));
  expect(combos.has("PUBLIC:APPROVED")).toBe(true);
  expect(combos.has("PRIVATE:PENDING")).toBe(true);
  expect(await prisma.trip.count({ where: { userId: dev!.id } })).toBe(2);

  const devPhoto = await prisma.footprintPhoto.findFirst({
    where: { footprintId: { in: devFps.map((f) => f.id) } },
  });
  expect(devPhoto).not.toBeNull();
  await expect(
    rawS3.send(new HeadObjectCommand({ Bucket: TEST_S3.bucket, Key: devPhoto!.mediaUrl })),
  ).resolves.toBeDefined();

  // likeCount 与 Like 行数全库一致（含 dev 点出赞抬高的 seed 足迹）
  const allFps = await prisma.footprint.findMany({ select: { id: true, likeCount: true } });
  for (const fp of allFps) {
    expect(fp.likeCount).toBe(await prisma.like.count({ where: { footprintId: fp.id } }));
  }
  expect(await prisma.like.count({ where: { userId: dev!.id } })).toBeGreaterThan(0);
}, 30000);

test("端到端：幂等——带扩展的 seed 重复运行数量不累积、sim- id 逐次相同；dev 用户不重建", async () => {
  await seedPlacesAndCards();
  const opts = { withCards: true, withDevAccount: true } as const;
  await seedProfile(prisma, storage, "sparse", opts);
  const firstDev = await findDevUser();
  const firstSimFps = (
    await prisma.footprint.findMany({ where: { id: { startsWith: "sim-" } }, orderBy: { id: "asc" } })
  ).map((f) => f.id);
  const firstCounts = {
    reports: await prisma.cardReport.count(),
    favorites: await prisma.cardFavorite.count(),
    retired: await prisma.card.count({ where: { status: "RETIRED" } }),
    trips: await prisma.trip.count(),
  };
  expect(firstSimFps.length).toBeGreaterThan(0);

  await seedProfile(prisma, storage, "sparse", opts);

  const secondDev = await findDevUser();
  expect(secondDev!.id).toBe(firstDev!.id); // upsert 复用，不删不重建
  const secondSimFps = (
    await prisma.footprint.findMany({ where: { id: { startsWith: "sim-" } }, orderBy: { id: "asc" } })
  ).map((f) => f.id);
  expect(secondSimFps).toEqual(firstSimFps);
  expect({
    reports: await prisma.cardReport.count(),
    favorites: await prisma.cardFavorite.count(),
    retired: await prisma.card.count({ where: { status: "RETIRED" } }),
    trips: await prisma.trip.count(),
  }).toEqual(firstCounts);
}, 30000);

test("端到端：wipe 清掉全部 sim- 行但保留 dev 用户本体；真实用户数据安然无恙", async () => {
  const places = await seedPlacesAndCards();
  // 非 seed 的真实 Apple 用户：subject 不带 "seed-" 前缀且非 dev，wipe 不应牵连。
  const real = await prisma.user.create({
    data: { nickname: "真实用户", identities: { create: { provider: "APPLE", subject: "real-user-1" } } },
  });
  const realFp = await prisma.footprint.create({
    data: {
      userId: real.id,
      placeId: places[0].id,
      date: new Date("2026-01-01T02:00:00.000Z"),
      visibility: "PUBLIC",
      reviewStatus: "APPROVED",
    },
  });

  await seedProfile(prisma, storage, "sparse", { withCards: true, withDevAccount: true });
  const dev = await findDevUser();

  await wipeSeedData(prisma, storage);

  expect(await prisma.footprint.count({ where: { id: { startsWith: "sim-" } } })).toBe(0);
  expect(await prisma.trip.count({ where: { id: { startsWith: "sim-" } } })).toBe(0);
  expect(await prisma.cardReport.count({ where: { id: { startsWith: "sim-" } } })).toBe(0);
  expect(await prisma.cardFavorite.count({ where: { id: { startsWith: "sim-" } } })).toBe(0);
  expect(await prisma.like.count({ where: { id: { startsWith: "sim-" } } })).toBe(0);

  // dev 用户本体保留（模拟器会话还要用），真实用户不受牵连
  expect(await prisma.user.findUnique({ where: { id: dev!.id } })).not.toBeNull();
  expect(await prisma.footprint.findUnique({ where: { id: realFp.id } })).not.toBeNull();
}, 30000);

test("端到端：dev 在 App 里手动收藏过的卡片不撞唯一约束——重跑 seed 不炸（wipe 不删非 sim- 的 dev 收藏）", async () => {
  await seedPlacesAndCards();
  const opts = { withCards: true, withDevAccount: true } as const;
  await seedProfile(prisma, storage, "sparse", opts);
  const dev = await findDevUser();

  // 模拟真实使用：dev 在模拟器里把所有卡都收藏了一遍（cuid 形状的 id，wipe 不会删）
  await prisma.cardFavorite.deleteMany({ where: { userId: dev!.id } }); // 先清计划行，只留"手动"行
  const cards = await prisma.card.findMany({ orderBy: { id: "asc" }, select: { id: true } });
  for (let i = 0; i < cards.length; i++) {
    await prisma.cardFavorite.create({
      data: { id: `manual-fav-${i + 1}`, userId: dev!.id, cardId: cards[i].id },
    });
  }

  await expect(seedProfile(prisma, storage, "sparse", opts)).resolves.toBeDefined();
  // 收藏状态收敛：每张卡至多一行（手动行或计划行），不重复
  const favs = await prisma.cardFavorite.findMany({ where: { userId: dev!.id } });
  const keys = favs.map((f) => f.cardId);
  expect(new Set(keys).size).toBe(keys.length);
}, 30000);

test("端到端：单独 --with-dev-account 时，dev 收藏也不指向库中已 RETIRED 的卡", async () => {
  await seedPlacesAndCards();
  // 只留 1 张存活卡，其余全部下架（模拟管理员或上一轮 --with-cards 的结果）
  await prisma.card.updateMany({ where: { id: { not: "card-4-3" } }, data: { status: "RETIRED" } });

  await seedProfile(prisma, storage, "sparse", { withDevAccount: true });

  const dev = await findDevUser();
  const favs = await prisma.cardFavorite.findMany({ where: { userId: dev!.id } });
  expect(favs.length).toBeGreaterThan(0);
  expect(favs.every((f) => f.cardId === "card-4-3")).toBe(true);
}, 30000);

test("CLI：--with-cards / --with-dev-account 必须与 --profile 同用，单独出现退出码 1", async () => {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await runCli(["--with-dev-account"], { databaseUrl: TEST_DB_URL, s3: TEST_S3 })).toBe(1);
    expect(await runCli(["--wipe", "--with-cards"], { databaseUrl: TEST_DB_URL, s3: TEST_S3 })).toBe(1);
    expect(errorSpy).toHaveBeenCalled();
  } finally {
    errorSpy.mockRestore();
  }
});

test("端到端：库中没有卡片时 --with-cards 优雅降级为 no-op（不报错，举报/收藏为 0）", async () => {
  // 只有地点，没有卡片
  await prisma.place.create({ data: { name: "北京市", level: "CITY", lat: 39.9, lng: 116.4 } });
  await prisma.place.create({ data: { name: "济南市", level: "CITY", lat: 36.65, lng: 117.12 } });
  await seedProfile(prisma, storage, "sparse", { withCards: true, withDevAccount: true });
  expect(await prisma.cardReport.count()).toBe(0);
  expect(await prisma.cardFavorite.count()).toBe(0);
  // dev 账号数据不依赖卡片，照常生成
  const dev = await findDevUser();
  expect(await prisma.footprint.count({ where: { userId: dev!.id } })).toBeGreaterThan(0);
}, 30000);
