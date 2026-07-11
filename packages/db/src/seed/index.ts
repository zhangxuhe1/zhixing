/**
 * seed CLI：三档模拟数据（rich / sparse）+ 独立可用的 --wipe。
 *
 * 契约要点（详见 .superpowers/sdd/m2-task-S11-brief.md）：
 * - 不联网、不调 LLM；全部随机决策经由 rng.ts 的确定性 PRNG（固定种子 42），
 *   同一份 Place 数据下重复运行产出逐字节相同的结果（含对象存储 key）。
 * - 幂等：seedProfile() 内部先 wipeSeedData() 再种，重复跑不累积。
 * - wipe 只清 (APPLE, subject 以 "seed-" 开头) 身份反查出的用户及其从属数据，绝不触碰其余用户。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createPrisma, type PrismaClient } from "../index.js";
import { createRng, type Rng } from "./rng.js";
import { NICKNAMES, STORY_TEMPLATES, fillStory } from "./corpus.js";
import {
  SEED_PREFIX,
  SIM_PREFIX,
  VIEW_COUNT_MAX,
  dateForDayIndex,
  photoObjectKey,
  type FootprintPlan,
  type LikePlan,
  type PhotoPlan,
  type PlaceLite,
  type ReviewStatus,
  type SeedPlan,
  type UserPlan,
} from "./common.js";
import {
  DEV_APPLE_SUB,
  DEV_NICKNAME,
  planCardOps,
  planDevAccount,
  planSeedEngagement,
  type CardLite,
  type CardOpsPlan,
  type DevAccountPlan,
  type SeedEngagementPlan,
} from "./extras.js";

// 向后兼容再导出：计划类型与对象键约定历史上从本模块导出（seed.test.ts 等仍这样引用）
export { photoObjectKey } from "./common.js";
export type {
  FootprintPlan,
  LikePlan,
  PhotoPlan,
  PlaceLite,
  SeedPlan,
  UserPlan,
} from "./common.js";

// ---------------------------------------------------------------------------
// env（与 apps/api、apps/pipeline 同款约定：自动加载仓库根 .env，不存在则跳过）
// ---------------------------------------------------------------------------

const envPath = fileURLToPath(new URL("../../../../.env", import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);

const DEFAULT_DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://zhixing:zhixing@localhost:5433/zhixing";

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
}

const DEFAULT_S3_CONFIG: S3Config = {
  endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
  region: process.env.S3_REGION ?? "us-east-1",
  bucket: process.env.S3_BUCKET ?? "zhixing",
  accessKey: process.env.S3_ACCESS_KEY ?? "zhixing",
  secretKey: process.env.S3_SECRET_KEY ?? "zhixing-secret",
};

const DEFAULT_ASSETS_DIR = fileURLToPath(new URL("../../seed-assets", import.meta.url));

// ---------------------------------------------------------------------------
// 最小 S3 封装（seed 只需要 put/remove/ensureBucket，presign 用不上）
// ---------------------------------------------------------------------------

export interface SeedStorage {
  ensureBucket(): Promise<void>;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export function createSeedStorage(cfg: S3Config): SeedStorage {
  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: true,
    credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
  });
  return {
    async ensureBucket() {
      try {
        await client.send(new HeadBucketCommand({ Bucket: cfg.bucket }));
      } catch {
        await client.send(new CreateBucketCommand({ Bucket: cfg.bucket }));
      }
    },
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: body, ContentType: contentType }),
      );
    },
    async remove(keys) {
      await Promise.all(
        keys.map((key) => client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }))),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// 素材加载（12 张 packages/db/seed-assets/*.jpg，一次性读入内存，运行期只读本地文件）
// ---------------------------------------------------------------------------

function loadSeedAssets(dir: string): Buffer[] {
  const files = readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".jpg"))
    .sort(); // 字典序 = seed-01.jpg..seed-12.jpg，顺序确定
  if (files.length === 0) {
    throw new Error(`seed-assets 目录为空：${dir}（先运行 python3 scripts/gen-seed-photos.py）`);
  }
  return files.map((f) => readFileSync(`${dir}/${f}`));
}

// ---------------------------------------------------------------------------
// 前置校验错误
// ---------------------------------------------------------------------------

export class NoPlacesError extends Error {
  constructor() {
    super("no places in database");
  }
}

// ---------------------------------------------------------------------------
// wipe：两条圈定线索——(APPLE, subject 前缀 "seed-") 的 Identity 反查出的用户（rich/sparse 档
// 产物）与 id startsWith "sim-" 的行（--with-cards / --with-dev-account 扩展产物）。
// 收集足迹照片 → 删 MinIO 对象 → 依序删 Like/CardReport/CardFavorite/FootprintPhoto/
// Footprint/Trip/User（尊重外键）→ 全量校正 likeCount。
// 绝不触碰非 seed 用户本体；dev 用户（simulator-dev）本体保留（模拟器会话还在用），
// 只清其 sim- 从属数据。卡片状态不回滚（重跑 --with-cards 会得到相同结果，见 extras.ts）。
// ---------------------------------------------------------------------------

export async function wipeSeedData(
  prisma: PrismaClient,
  storage: SeedStorage,
): Promise<{ users: number; footprints: number; photos: number }> {
  // seed 用户经 (APPLE, subject 前缀 SEED_PREFIX) 的 Identity 反查——user.appleSub 已停止读写。
  // S1 迁移已为既有 seed 用户回填 APPLE Identity，改走 Identity 圈定不丢任何行；删 User 时
  // 其 Identity 随 onDelete: Cascade 一并清除。
  const seedIdentities = await prisma.identity.findMany({
    where: { provider: "APPLE", subject: { startsWith: SEED_PREFIX } },
    select: { userId: true },
  });
  const userIds = seedIdentities.map((i) => i.userId);

  const footprints = await prisma.footprint.findMany({
    where: { OR: [{ userId: { in: userIds } }, { id: { startsWith: SIM_PREFIX } }] },
    select: { id: true },
  });
  const footprintIds = footprints.map((f) => f.id);

  const photos = await prisma.footprintPhoto.findMany({
    where: { footprintId: { in: footprintIds } },
    select: { mediaUrl: true },
  });
  await storage.remove(photos.map((p) => p.mediaUrl));

  await prisma.like.deleteMany({
    where: {
      OR: [
        { userId: { in: userIds } },
        { footprintId: { in: footprintIds } },
        { id: { startsWith: SIM_PREFIX } },
      ],
    },
  });
  await prisma.cardReport.deleteMany({
    where: { OR: [{ userId: { in: userIds } }, { id: { startsWith: SIM_PREFIX } }] },
  });
  await prisma.cardFavorite.deleteMany({
    where: { OR: [{ userId: { in: userIds } }, { id: { startsWith: SIM_PREFIX } }] },
  });
  await prisma.footprintPhoto.deleteMany({ where: { footprintId: { in: footprintIds } } });
  await prisma.footprint.deleteMany({ where: { id: { in: footprintIds } } });
  await prisma.trip.deleteMany({
    where: { OR: [{ userId: { in: userIds } }, { id: { startsWith: SIM_PREFIX } }] },
  });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });

  // 点赞行删除后全量校正 likeCount：seed 用户与 dev 账号互相点赞后，任何一侧被删
  // 都可能在幸存足迹上留下偏差；一条 SQL 全表校正，seed 规模下开销可忽略。
  // 注意这是"只清 seed 数据"契约的有意例外：可能改写非 seed 足迹的 likeCount，
  // 但只朝正确值收敛（likeCount := 实际 Like 行数），已一致的行是 no-op。
  await prisma.$executeRawUnsafe(`
    UPDATE "Footprint" f SET "likeCount" = sub.n
    FROM (
      SELECT f2.id, COALESCE(l.n, 0) AS n
      FROM "Footprint" f2
      LEFT JOIN (SELECT "footprintId", count(*)::int AS n FROM "Like" GROUP BY "footprintId") l
        ON l."footprintId" = f2.id
    ) sub
    WHERE f.id = sub.id AND f."likeCount" <> sub.n
  `);

  return { users: userIds.length, footprints: footprintIds.length, photos: photos.length };
}

// ---------------------------------------------------------------------------
// 规划阶段（纯函数，不碰 DB/网络）：产出完整的写入计划，写入阶段照单全收即可。
// 把"决定造什么"和"怎么落库"分离，既方便单测确定性，也让落库阶段能批量 createMany。
// ---------------------------------------------------------------------------

function storyText(rng: Rng, placeName: string): string {
  return fillStory(rng.pick(STORY_TEMPLATES), placeName);
}

interface TimelineEvent {
  dayIndex: number;
  place: PlaceLite;
}

/**
 * 单个用户的日期/地点时间轴：常驻地日常散点（互相间隔 >=3 天，绝不聚簇）
 * + 2-4 段"旅行簇"（段内相邻 1 天，段间与散点间隔 >=3 天，避免被 S6 划界误并/误拆）。
 * 地点/资金预算不足两个地点时优雅降级为全部落在常驻地（不生成旅行簇）。
 */
function planUserTimeline(
  rng: Rng,
  total: number,
  residentPlace: PlaceLite,
  awayPlaces: PlaceLite[],
): TimelineEvent[] {
  const canTrip = awayPlaces.length > 0 && total >= 3;
  const maxTripsByBudget = Math.max(0, Math.floor((total - 1) / 2));
  const numTrips = canTrip ? Math.min(rng.int(2, 4), maxTripsByBudget) : 0;

  const tripSizes: number[] = [];
  let remaining = total;
  for (let t = 0; t < numTrips; t++) {
    const reserveForRest = (numTrips - t - 1) * 2 + 1; // 其余行程各留 >=2 天 + 常驻至少留 1 天
    const maxSize = Math.min(5, remaining - reserveForRest);
    if (maxSize < 2) break;
    const size = rng.int(2, maxSize);
    tripSizes.push(size);
    remaining -= size;
  }
  const residentCount = remaining;

  type Token = { kind: "resident" } | { kind: "trip"; size: number };
  const tokens: Token[] = [
    ...Array.from({ length: residentCount }, (): Token => ({ kind: "resident" })),
    ...tripSizes.map((size): Token => ({ kind: "trip", size })),
  ];
  const order = rng.shuffle(tokens);
  const shuffledAway = rng.shuffle(awayPlaces.length > 0 ? awayPlaces : [residentPlace]);

  const events: TimelineEvent[] = [];
  let cursor = rng.int(0, 20);
  let awayCursor = 0;
  for (const token of order) {
    cursor += rng.int(3, 10); // 与上一段末尾的最小间隔，防止被划界算法误并
    if (token.kind === "resident") {
      events.push({ dayIndex: cursor, place: residentPlace });
    } else {
      const place = shuffledAway[awayCursor % shuffledAway.length];
      awayCursor++;
      for (let d = 0; d < token.size; d++) {
        events.push({ dayIndex: cursor, place });
        cursor += 1;
      }
      cursor -= 1; // 下一 token 的间隔以本段最后一天为基准
    }
  }
  return events;
}

const RICH_USER_COUNT = 30;
const RICH_FOOTPRINT_MIN = 5;
const RICH_FOOTPRINT_MAX = 25;
const RICH_PUBLIC_RATIO = 0.4;
const RICH_APPROVED_RATIO = 0.75;
const RICH_PENDING_RATIO = 0.15; // 剩余 0.10 归 REJECTED
const RICH_PHOTO_MAX = 3;
const RICH_MAX_LIKERS = 15;

export function planRich(rng: Rng, places: PlaceLite[]): SeedPlan {
  const users: UserPlan[] = Array.from({ length: RICH_USER_COUNT }, (_, i) => ({
    id: `seed-u${i + 1}`,
    appleSub: `${SEED_PREFIX}${i + 1}`,
    nickname: rng.pick(NICKNAMES),
  }));

  const footprints: FootprintPlan[] = [];
  const photos: PhotoPlan[] = [];
  let assetCursor = 0;

  for (let ui = 0; ui < users.length; ui++) {
    const total = rng.int(RICH_FOOTPRINT_MIN, RICH_FOOTPRINT_MAX);
    const residentPlace = rng.pick(places);
    const awayPlaces = places.filter((p) => p.id !== residentPlace.id);
    const events = planUserTimeline(rng, total, residentPlace, awayPlaces);

    for (let fi = 0; fi < events.length; fi++) {
      const ev = events[fi];
      const footprintId = `seed-fp-${ui + 1}-${fi + 1}`;
      const date = dateForDayIndex(ev.dayIndex);
      const isPublic = rng.chance(RICH_PUBLIC_RATIO);

      let reviewStatus: ReviewStatus = "PENDING";
      let publicRequestedAt: Date | null = null;
      if (isPublic) {
        const roll = rng.next();
        reviewStatus =
          roll < RICH_APPROVED_RATIO
            ? "APPROVED"
            : roll < RICH_APPROVED_RATIO + RICH_PENDING_RATIO
              ? "PENDING"
              : "REJECTED";
        publicRequestedAt = date;
      }

      footprints.push({
        id: footprintId,
        userId: users[ui].id,
        placeId: ev.place.id,
        placeLat: ev.place.lat,
        placeLng: ev.place.lng,
        text: storyText(rng, ev.place.name),
        date,
        visibility: isPublic ? "PUBLIC" : "PRIVATE",
        reviewStatus,
        publicRequestedAt,
        viewCount: rng.int(0, VIEW_COUNT_MAX),
        likeCount: 0, // 点赞规划阶段回填
      });

      const photoCount = rng.int(0, RICH_PHOTO_MAX);
      for (let pi = 0; pi < photoCount; pi++) {
        photos.push({
          id: `seed-ph-${ui + 1}-${fi + 1}-${pi + 1}`,
          footprintId,
          uuid: rng.uuid(),
          assetIndex: assetCursor++,
          takenAt: date,
          lat: ev.place.lat + (rng.next() - 0.5) * 0.02,
          lng: ev.place.lng + (rng.next() - 0.5) * 0.02,
        });
      }
    }
  }

  // 互相点亮：只在 PUBLIC+APPROVED 上发生（与真实 API 的可点赞判据一致），排除自赞。
  const likable = footprints.filter((f) => f.visibility === "PUBLIC" && f.reviewStatus === "APPROVED");
  const likes: LikePlan[] = [];
  for (const fp of likable) {
    const candidates = users.filter((u) => u.id !== fp.userId);
    const likerCount = rng.int(0, Math.min(candidates.length, RICH_MAX_LIKERS));
    const likers = rng.shuffle(candidates).slice(0, likerCount);
    likers.forEach((liker, i) => {
      likes.push({ id: `seed-like-${fp.id}-${i + 1}`, userId: liker.id, footprintId: fp.id });
    });
    fp.likeCount = likers.length; // 与实际 Like 行数保持一致
  }

  return { users, footprints, photos, likes };
}

const SPARSE_USER_COUNT = 3;
const SPARSE_FOOTPRINT_TOTAL = 10;
const SPARSE_PLACE_COUNT = 2;
const SPARSE_PHOTO_CHANCE = 0.4;

function distribute(total: number, parts: number): number[] {
  const base = Math.floor(total / parts);
  const rem = total % parts;
  return Array.from({ length: parts }, (_, i) => base + (i < rem ? 1 : 0));
}

export function planSparse(rng: Rng, places: PlaceLite[]): SeedPlan {
  const chosenPlaces = places.slice(0, Math.min(SPARSE_PLACE_COUNT, places.length));

  const users: UserPlan[] = Array.from({ length: SPARSE_USER_COUNT }, (_, i) => ({
    id: `seed-u${i + 1}`,
    appleSub: `${SEED_PREFIX}${i + 1}`,
    nickname: NICKNAMES[i % NICKNAMES.length],
  }));

  const perUser = distribute(SPARSE_FOOTPRINT_TOTAL, SPARSE_USER_COUNT);
  const footprints: FootprintPlan[] = [];
  const photos: PhotoPlan[] = [];
  let dayIndex = rng.int(0, 10);
  let assetCursor = 0;
  let globalFpIndex = 0;

  for (let ui = 0; ui < users.length; ui++) {
    for (let k = 0; k < perUser[ui]; k++) {
      const place = chosenPlaces[globalFpIndex % chosenPlaces.length];
      dayIndex += rng.int(1, 4);
      const date = dateForDayIndex(dayIndex);
      const footprintId = `seed-fp-${ui + 1}-${k + 1}`;

      footprints.push({
        id: footprintId,
        userId: users[ui].id,
        placeId: place.id,
        placeLat: place.lat,
        placeLng: place.lng,
        text: storyText(rng, place.name),
        date,
        visibility: "PUBLIC",
        reviewStatus: "APPROVED",
        publicRequestedAt: date,
        viewCount: rng.int(0, VIEW_COUNT_MAX),
        likeCount: 0,
      });

      if (rng.chance(SPARSE_PHOTO_CHANCE)) {
        photos.push({
          id: `seed-ph-${ui + 1}-${k + 1}-1`,
          footprintId,
          uuid: rng.uuid(),
          assetIndex: assetCursor++,
          takenAt: date,
          lat: place.lat,
          lng: place.lng,
        });
      }
      globalFpIndex++;
    }
  }

  return { users, footprints, photos, likes: [] }; // sparse 契约未提及点赞，保持最小
}

export type ProfileName = "rich" | "sparse";

function planProfile(profile: ProfileName, rng: Rng, places: PlaceLite[]): SeedPlan {
  return profile === "rich" ? planRich(rng, places) : planSparse(rng, places);
}

// ---------------------------------------------------------------------------
// 落库：规划阶段已经决定好一切，这里只管批量写入 + 上传照片字节。
// ---------------------------------------------------------------------------

const PHOTO_UPLOAD_CONCURRENCY = 20;

async function applyPlan(
  prisma: PrismaClient,
  storage: SeedStorage,
  plan: SeedPlan,
  assets: Buffer[],
): Promise<void> {
  if (plan.users.length > 0) {
    await prisma.user.createMany({
      data: plan.users.map((u) => ({ id: u.id, nickname: u.nickname })),
    });
    // 每个 seed 用户配一条 APPLE Identity（subject = 计划里的 appleSub 字段）——与登录首登产物
    // 同构，wipe 经此圈定；user.appleSub 不再写入（S3 删列）。Identity.id 走默认 cuid，不参与
    // 确定性断言（footprintId / 对象键才需逐次相同）。
    await prisma.identity.createMany({
      data: plan.users.map((u) => ({ provider: "APPLE", subject: u.appleSub, userId: u.id })),
    });
  }
  if (plan.footprints.length > 0) {
    await prisma.footprint.createMany({
      data: plan.footprints.map((f) => ({
        id: f.id,
        userId: f.userId,
        placeId: f.placeId,
        text: f.text,
        date: f.date,
        visibility: f.visibility,
        reviewStatus: f.reviewStatus,
        publicRequestedAt: f.publicRequestedAt,
        viewCount: f.viewCount,
        likeCount: f.likeCount,
        tripId: f.tripId ?? null,
      })),
    });
  }
  if (plan.likes.length > 0) {
    await prisma.like.createMany({
      data: plan.likes.map((l) => ({ id: l.id, userId: l.userId, footprintId: l.footprintId })),
    });
  }

  for (let i = 0; i < plan.photos.length; i += PHOTO_UPLOAD_CONCURRENCY) {
    const batch = plan.photos.slice(i, i + PHOTO_UPLOAD_CONCURRENCY);
    await Promise.all(
      batch.map((p) =>
        storage.put(photoObjectKey(p.footprintId, p.uuid), assets[p.assetIndex % assets.length], "image/jpeg"),
      ),
    );
  }
  if (plan.photos.length > 0) {
    await prisma.footprintPhoto.createMany({
      data: plan.photos.map((p) => ({
        id: p.id,
        footprintId: p.footprintId,
        mediaUrl: photoObjectKey(p.footprintId, p.uuid),
        takenAt: p.takenAt,
        lat: p.lat,
        lng: p.lng,
      })),
    });
  }
}

export interface SeedStats {
  profile: ProfileName;
  users: number;
  footprints: number;
  photos: number;
  publicFootprints: number;
  approvedFootprints: number;
  pendingFootprints: number;
  rejectedFootprints: number;
  likes: number;
  // --with-cards 时填充
  cardsReviewed?: number;
  cardsRetired?: number;
  cardReports?: number;
  // --with-cards / --with-dev-account 任一开启即填充（两者的收藏合并计数）
  cardFavorites?: number;
  // --with-dev-account 时填充
  devFootprints?: number;
  devPhotos?: number;
  devTrips?: number;
  devLikes?: number;
}

interface ExtrasPlans {
  cardOps: CardOpsPlan | null;
  engagement: SeedEngagementPlan | null;
  devPlan: DevAccountPlan | null;
}

function computeStats(profile: ProfileName, plan: SeedPlan, extras: ExtrasPlans): SeedStats {
  const pub = plan.footprints.filter((f) => f.visibility === "PUBLIC");
  const stats: SeedStats = {
    profile,
    users: plan.users.length,
    footprints: plan.footprints.length,
    photos: plan.photos.length,
    publicFootprints: pub.length,
    approvedFootprints: pub.filter((f) => f.reviewStatus === "APPROVED").length,
    pendingFootprints: pub.filter((f) => f.reviewStatus === "PENDING").length,
    rejectedFootprints: pub.filter((f) => f.reviewStatus === "REJECTED").length,
    likes: plan.likes.length,
  };
  if (extras.cardOps) {
    stats.cardsReviewed = extras.cardOps.reviewedIds.length;
    stats.cardsRetired = extras.cardOps.retiredIds.length;
    stats.cardReports = extras.engagement?.reports.length ?? 0;
  }
  if (extras.engagement || extras.devPlan) {
    stats.cardFavorites =
      (extras.engagement?.favorites.length ?? 0) + (extras.devPlan?.favorites.length ?? 0);
  }
  if (extras.devPlan) {
    stats.devFootprints = extras.devPlan.footprints.length;
    stats.devPhotos = extras.devPlan.photos.length;
    stats.devTrips = extras.devPlan.trips.length;
    stats.devLikes = extras.devPlan.likesIn.length + extras.devPlan.likesOut.length;
  }
  return stats;
}

const SEED_RNG_SEED = 42;

export interface SeedOptions {
  assetsDir?: string;
  /** 卡片状态多样化（REVIEWED/RETIRED）+ seed 用户的收藏与举报队列；库中无卡片时为提示性 no-op */
  withCards?: boolean;
  /** dev 账号（simulator-dev）个人数据：四种状态足迹、行程、未归组日期簇、照片、双向点赞、收藏 */
  withDevAccount?: boolean;
}

/**
 * 圈定"存活"卡片（收藏/举报只指向它们）：剔除本轮计划下架的，也剔除库中已经
 * RETIRED 的——单独 --with-dev-account（无 cardOps）时后者是唯一的过滤线索。
 */
function aliveCards(
  cards: (CardLite & { status: string })[],
  ops: CardOpsPlan | null,
): CardLite[] {
  const retired = new Set(ops?.retiredIds ?? []);
  return cards
    .filter((c) => c.status !== "RETIRED" && !retired.has(c.id))
    .map((c) => ({ id: c.id, placeId: c.placeId }));
}

/**
 * 种一档模拟数据：内部先 wipeSeedData() 再种（幂等，重复跑不累积），
 * 库中没有 Place 时抛 NoPlacesError。规划与落库分离，规划阶段是纯函数，
 * 同一份 Place/Card 输入下逐字节确定（含对象存储 key）。
 */
export async function seedProfile(
  prisma: PrismaClient,
  storage: SeedStorage,
  profile: ProfileName,
  opts: SeedOptions = {},
): Promise<SeedStats> {
  await wipeSeedData(prisma, storage);

  const places = await prisma.place.findMany({
    orderBy: { id: "asc" }, // 顺序必须稳定，否则同一份数据两次运行会选出不同的常驻地/旅行地
    select: { id: true, name: true, lat: true, lng: true },
  });
  if (places.length === 0) throw new NoPlacesError();

  const assets = loadSeedAssets(opts.assetsDir ?? DEFAULT_ASSETS_DIR);
  const rng = createRng(SEED_RNG_SEED);
  const plan = planProfile(profile, rng, places);

  // 卡片按 id 稳定排序读取，且 planCardOps 的输入不过滤状态——它只看顺序与地点分组，
  // 这样重跑时（部分卡已被上一轮标为 RETIRED）仍会选出同一批 id，保证幂等。
  const cards: (CardLite & { status: string })[] =
    opts.withCards || opts.withDevAccount
      ? await prisma.card.findMany({
          orderBy: { id: "asc" },
          select: { id: true, placeId: true, status: true },
        })
      : [];

  let cardOps: CardOpsPlan | null = null;
  let engagement: SeedEngagementPlan | null = null;
  if (opts.withCards) {
    if (cards.length === 0) {
      console.warn(
        "库中没有 Card，--with-cards 跳过（先运行 pipeline 的 generate/batch 生成卡片）",
      );
    } else {
      cardOps = planCardOps(cards);
      engagement = planSeedEngagement(
        rng,
        aliveCards(cards, cardOps),
        plan.users.map((u) => u.id),
      );
    }
  }

  let devPlan: DevAccountPlan | null = null;
  let devUserId: string | null = null;
  if (opts.withDevAccount) {
    // dev 用户按 (APPLE, simulator-dev) 身份查 Identity，与 API 的 POST /auth/dev 首登产物同构：
    // 命中（登录过或上轮 seed 建过）则原样复用不重建；未命中则显式 id 建 User + APPLE Identity。
    // 先 seed 后登录、或先登录后 seed，都复用同一 Identity 行；wipe 也不删它（subject 非 seed- 前缀）——
    // 模拟器里的会话 token 还指着这行。
    const existingDev = await prisma.identity.findUnique({
      where: { provider_subject: { provider: "APPLE", subject: DEV_APPLE_SUB } },
      select: { userId: true },
    });
    if (existingDev) {
      devUserId = existingDev.userId;
    } else {
      const devUser = await prisma.user.create({
        data: {
          id: `${SIM_PREFIX}dev-user`,
          nickname: DEV_NICKNAME,
          identities: { create: { provider: "APPLE", subject: DEV_APPLE_SUB } },
        },
      });
      devUserId = devUser.id;
    }
    devPlan = planDevAccount(rng, {
      devUserId,
      places,
      seedUsers: plan.users,
      seedFootprints: plan.footprints,
      cards: aliveCards(cards, cardOps),
    });
    // dev 点出的赞落在 seed 足迹上：落库前把目标行的 likeCount +1，
    // 保持"likeCount 恒等于 Like 行数"的写入不变量（不靠事后 SQL 校正）。
    const byId = new Map(plan.footprints.map((f) => [f.id, f]));
    for (const like of devPlan.likesOut) byId.get(like.footprintId)!.likeCount += 1;
  }

  await applyPlan(prisma, storage, plan, assets);

  if (cardOps) {
    if (cardOps.reviewedIds.length > 0) {
      await prisma.card.updateMany({
        where: { id: { in: cardOps.reviewedIds } },
        data: { status: "REVIEWED" },
      });
    }
    if (cardOps.retiredIds.length > 0) {
      await prisma.card.updateMany({
        where: { id: { in: cardOps.retiredIds } },
        data: { status: "RETIRED" },
      });
    }
  }
  if (engagement) {
    if (engagement.favorites.length > 0) {
      await prisma.cardFavorite.createMany({ data: engagement.favorites, skipDuplicates: true });
    }
    if (engagement.reports.length > 0) {
      await prisma.cardReport.createMany({ data: engagement.reports });
    }
  }
  if (devPlan && devUserId) {
    // 行程先于足迹落库（Footprint.tripId 外键）
    if (devPlan.trips.length > 0) {
      await prisma.trip.createMany({
        data: devPlan.trips.map((t) => ({
          id: t.id,
          userId: devUserId!,
          title: t.title,
          startDate: t.startDate,
          endDate: t.endDate,
        })),
      });
    }
    await applyPlan(
      prisma,
      storage,
      {
        users: [], // dev 用户已 upsert，不走 createMany
        footprints: devPlan.footprints,
        photos: devPlan.photos,
        likes: [...devPlan.likesIn, ...devPlan.likesOut],
      },
      assets,
    );
    // skipDuplicates：dev 在 App 里手动收藏过的行（cuid id，wipe 不删）与计划行撞
    // (userId, cardId) 唯一约束时静默跳过——收藏状态收敛即可，不苛求行 id 归属。
    // 注意点赞的 createMany 不能加 skipDuplicates：跳行会让预先 +1 的 likeCount 失真。
    if (devPlan.favorites.length > 0) {
      await prisma.cardFavorite.createMany({ data: devPlan.favorites, skipDuplicates: true });
    }
  }

  return computeStats(profile, plan, { cardOps, engagement, devPlan });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface ParsedArgs {
  profile?: ProfileName;
  wipeOnly: boolean;
  withCards: boolean;
  withDevAccount: boolean;
  error?: string;
}

const USAGE =
  "用法：pnpm -C packages/db seed --profile rich|sparse [--with-cards] [--with-dev-account] [--wipe]；" +
  "或单独 pnpm -C packages/db seed --wipe 只清不种";

function parseCliArgs(argv: string[]): ParsedArgs {
  let profileRaw: string | undefined;
  let wipe = false;
  let withCards = false;
  let withDevAccount = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--profile") profileRaw = argv[++i];
    else if (argv[i] === "--wipe") wipe = true;
    else if (argv[i] === "--with-cards") withCards = true;
    else if (argv[i] === "--with-dev-account") withDevAccount = true;
  }
  const base = { wipeOnly: false, withCards, withDevAccount };
  if (!profileRaw && !wipe) return { ...base, error: USAGE };
  if (!profileRaw && (withCards || withDevAccount)) {
    return { ...base, error: `--with-cards / --with-dev-account 需要与 --profile 同用\n${USAGE}` };
  }
  if (profileRaw && profileRaw !== "rich" && profileRaw !== "sparse") {
    return { ...base, error: `未知 profile："${profileRaw}"（仅支持 rich|sparse）\n${USAGE}` };
  }
  return { ...base, profile: profileRaw as ProfileName | undefined, wipeOnly: !profileRaw };
}

function formatStats(stats: SeedStats): string {
  let out =
    `seed[${stats.profile}] 用户 ${stats.users}，足迹 ${stats.footprints}，照片 ${stats.photos}，` +
    `公开 ${stats.publicFootprints}（APPROVED ${stats.approvedFootprints} / PENDING ${stats.pendingFootprints} / REJECTED ${stats.rejectedFootprints}），` +
    `点赞 ${stats.likes}`;
  if (stats.cardsReviewed !== undefined) {
    out += `；卡片 REVIEWED ${stats.cardsReviewed} / RETIRED ${stats.cardsRetired}，举报 ${stats.cardReports}`;
  }
  if (stats.cardFavorites !== undefined) {
    out += `，收藏 ${stats.cardFavorites}`;
  }
  if (stats.devFootprints !== undefined) {
    out += `；dev 足迹 ${stats.devFootprints}（照片 ${stats.devPhotos}，行程 ${stats.devTrips}，点赞 ${stats.devLikes}）`;
  }
  return out;
}

export interface CliDeps {
  databaseUrl?: string;
  s3?: S3Config;
  assetsDir?: string;
}

/** 供 CLI 入口与测试共用；不直接调用 process.exit，返回值即约定的退出码。 */
export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const parsed = parseCliArgs(argv);
  if (parsed.error) {
    console.error(parsed.error);
    return 1;
  }

  const prisma = createPrisma(deps.databaseUrl ?? DEFAULT_DATABASE_URL);
  const storage = createSeedStorage(deps.s3 ?? DEFAULT_S3_CONFIG);
  try {
    await storage.ensureBucket();

    if (parsed.wipeOnly) {
      const result = await wipeSeedData(prisma, storage);
      console.log(`已清理 seed 数据：用户 ${result.users} 个，足迹 ${result.footprints} 条，照片 ${result.photos} 张`);
      return 0;
    }

    try {
      const stats = await seedProfile(prisma, storage, parsed.profile!, {
        assetsDir: deps.assetsDir,
        withCards: parsed.withCards,
        withDevAccount: parsed.withDevAccount,
      });
      console.log(formatStats(stats));
      return 0;
    } catch (err) {
      if (err instanceof NoPlacesError) {
        console.error(
          "数据库中没有 Place，请先运行内容导入：pnpm --filter @zhixing/pipeline import-places 与 import-regions",
        );
        return 1;
      }
      throw err;
    }
  } finally {
    await prisma.$disconnect();
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  // pnpm run 有时会把 "--" 透传进来，剥掉它（同 apps/pipeline/src/batch.ts 的处理）
  const rawArgs = process.argv.slice(2);
  const argv = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  runCli(argv)
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
