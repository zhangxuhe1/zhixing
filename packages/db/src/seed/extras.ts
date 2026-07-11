/**
 * seed CLI 扩展规划（纯函数，不碰 DB/网络）：
 * - planCardOps：卡片状态多样化（REVIEWED / RETIRED），只依赖卡片顺序与地点分组，天然幂等；
 * - planSeedEngagement：seed 用户的卡片收藏 + 举报队列（管理端有东西可处理）；
 * - planDevAccount：dev 账号（APPLE 身份 subject=simulator-dev）的个人数据——四种状态混合的足迹、
 *   2 段行程、1 个未归组连续日期簇（供 /me/trip-suggestions 演示）、照片、双向点赞、卡片收藏。
 *
 * 所有新建行 id 以 SIM_PREFIX（"sim-"）开头，供 wipe 精确圈定；所有随机决策经由注入的 Rng，
 * 同一 seed 同一输入产出逐字节相同的计划。
 */
import type { Rng } from "./rng.js";
import {
  SIM_PREFIX,
  VIEW_COUNT_MAX,
  dateForDayIndex,
  type FootprintPlan,
  type LikePlan,
  type PhotoPlan,
  type PlaceLite,
  type ReviewStatus,
  type UserPlan,
  type Visibility,
} from "./common.js";
import { STORY_TEMPLATES, fillStory } from "./corpus.js";

/** dev 账号的 APPLE 身份 subject——与 apps/api 的 dev 登录（POST /auth/dev，按 (APPLE, subject)
 *  查 Identity）保持一致，seed 先建后登录、或先登录后 seed 都复用同一 Identity 行。 */
export const DEV_APPLE_SUB = "simulator-dev";
/** 与 dev 登录的缺省昵称规则（旅人 + subject 后 4 位）产出一致："simulator-dev" 后 4 位即 "-dev"。 */
export const DEV_NICKNAME = "旅人-dev";

export interface CardLite {
  id: string;
  placeId: string;
}

// ---------------------------------------------------------------------------
// 卡片状态多样化
// ---------------------------------------------------------------------------

export interface CardOpsPlan {
  /** 改标 REVIEWED 的卡片 id（已剔除 retiredIds） */
  reviewedIds: string[];
  /** 改标 RETIRED 的卡片 id */
  retiredIds: string[];
}

const RETIRE_PLACE_COUNT = 3;

/**
 * 每 3 张取 1 张标 REVIEWED；再从前 3 个"卡片数 >=3"的地点各下架末张（保证地点仍有可见卡）。
 * 只看输入顺序与地点分组、不看当前状态，因此重跑对同一份卡片数据恒产出同一批 id。
 * 注意：不记录原状态，--wipe 不回滚卡片状态（重跑会得到相同结果，视为开发库的既定演示状态）。
 */
export function planCardOps(cards: CardLite[]): CardOpsPlan {
  const byPlace = new Map<string, string[]>();
  for (const c of cards) byPlace.set(c.placeId, [...(byPlace.get(c.placeId) ?? []), c.id]);

  const retiredIds = [...byPlace.values()]
    .filter((ids) => ids.length >= 3)
    .slice(0, RETIRE_PLACE_COUNT)
    .map((ids) => ids[ids.length - 1]);
  const retired = new Set(retiredIds);

  const reviewedIds = cards
    .filter((_, i) => i % 3 === 0)
    .map((c) => c.id)
    .filter((id) => !retired.has(id));

  return { reviewedIds, retiredIds };
}

// ---------------------------------------------------------------------------
// seed 用户的收藏与举报
// ---------------------------------------------------------------------------

export interface FavoritePlan {
  id: string;
  userId: string;
  cardId: string;
}

export interface ReportPlan {
  id: string;
  cardId: string;
  userId: string;
  text: string;
  status: "OPEN" | "RESOLVED";
}

export interface SeedEngagementPlan {
  favorites: FavoritePlan[];
  reports: ReportPlan[];
}

const FAVORITE_USER_COUNT = 5;
const FAVORITES_PER_USER = 2;

/** 举报文案固定 6 条；末条 RESOLVED，其余 OPEN，让管理端队列既有待办也有已办样例。 */
const REPORT_TEXTS: readonly string[] = [
  "这张卡说的年代不对，应该是清末不是明末，建议核实。",
  "内容和另一张卡几乎重复，是不是生成重了？",
  "方言注音标错了，本地人不这么念。",
  "引用的来源链接点不开了。",
  "图文不符，说的是小吃但通篇在讲建筑。",
  "错别字：第二段「传乘」应为「传承」。",
];

/**
 * cards 应传入"下架后仍存活"的卡片（收藏/举报不指向 RETIRED 卡）。
 * 收藏用 shuffle+slice 保证 (userId, cardId) 不撞唯一约束；没有 seed 用户时整体为空。
 */
export function planSeedEngagement(
  rng: Rng,
  cards: CardLite[],
  seedUserIds: string[],
): SeedEngagementPlan {
  if (cards.length === 0 || seedUserIds.length === 0) return { favorites: [], reports: [] };

  const favorites: FavoritePlan[] = [];
  const favUsers = seedUserIds.slice(0, FAVORITE_USER_COUNT);
  for (let u = 0; u < favUsers.length; u++) {
    const picks = rng.shuffle(cards).slice(0, Math.min(FAVORITES_PER_USER, cards.length));
    picks.forEach((card, k) => {
      favorites.push({ id: `${SIM_PREFIX}fav-s${u + 1}-${k + 1}`, userId: favUsers[u], cardId: card.id });
    });
  }

  const reportCards = rng.shuffle(cards).slice(0, Math.min(REPORT_TEXTS.length, cards.length));
  const reports: ReportPlan[] = reportCards.map((card, k) => ({
    id: `${SIM_PREFIX}rep-${k + 1}`,
    cardId: card.id,
    userId: seedUserIds[k % seedUserIds.length],
    text: REPORT_TEXTS[k],
    status: k === reportCards.length - 1 ? "RESOLVED" : "OPEN",
  }));

  return { favorites, reports };
}

// ---------------------------------------------------------------------------
// dev 账号个人数据
// ---------------------------------------------------------------------------

export interface TripPlan {
  id: string;
  title: string;
  placeId: string;
  startDate: Date;
  endDate: Date;
}

export interface DevAccountInput {
  devUserId: string;
  places: PlaceLite[];
  seedUsers: UserPlan[];
  /** 当前档位计划中的 seed 足迹，dev 的"点出赞"只指向其中 PUBLIC+APPROVED 的行 */
  seedFootprints: FootprintPlan[];
  /** 存活（非 RETIRED）卡片，dev 的收藏从中挑选；可为空 */
  cards: CardLite[];
}

export interface DevAccountPlan {
  trips: TripPlan[];
  footprints: FootprintPlan[];
  photos: PhotoPlan[];
  /** seed 用户 → dev 足迹的赞（likeCount 已回填到 footprints） */
  likesIn: LikePlan[];
  /** dev → seed 足迹的赞（落库前需由编排方把目标足迹的 likeCount +1） */
  likesOut: LikePlan[];
  favorites: FavoritePlan[];
}

const DEV_SCATTER_COUNT = 8;
/** 常驻地散点的状态循环模式：四种可见性/审核组合齐备（与真实用户的混合形态一致）。 */
const SCATTER_STATES: readonly [Visibility, ReviewStatus][] = [
  ["PUBLIC", "APPROVED"],
  ["PRIVATE", "PENDING"],
  ["PUBLIC", "PENDING"],
  ["PUBLIC", "REJECTED"],
  ["PUBLIC", "APPROVED"],
  ["PRIVATE", "PENDING"],
  ["PUBLIC", "APPROVED"],
  ["PRIVATE", "PENDING"],
];
/** 行程 2 的状态：整段未公开/待审，演示"行程内也可以有私密足迹"。 */
const TRIP2_STATES: readonly [Visibility, ReviewStatus][] = [
  ["PRIVATE", "PENDING"],
  ["PUBLIC", "PENDING"],
  ["PRIVATE", "PENDING"],
];
/** 未归组簇的状态。 */
const LOOSE_STATES: readonly [Visibility, ReviewStatus][] = [
  ["PRIVATE", "PENDING"],
  ["PUBLIC", "APPROVED"],
];

const DEV_MAX_LIKERS = 12;
const DEV_LIKES_OUT_MAX = 8;
const DEV_FAVORITES_MAX = 8;

type Segment =
  | { kind: "scatter"; state: [Visibility, ReviewStatus] }
  | { kind: "trip"; index: 1 | 2; place: PlaceLite; states: readonly [Visibility, ReviewStatus][] }
  | { kind: "loose"; place: PlaceLite; states: readonly [Visibility, ReviewStatus][] };

/**
 * dev 账号计划：8 个常驻地散点 + 2 段行程（各 3 天连续、单一地点）+ 1 个未归组的
 * 2 天连续簇（tripId 为空，留给行程建议功能自动划界）。段与段之间至少隔 3 天，
 * 防止被划界算法误并；行程/簇内相邻 1 天。行程足迹必有照片（旅行总要拍点什么）。
 */
export function planDevAccount(rng: Rng, input: DevAccountInput): DevAccountPlan {
  const { devUserId, places, seedUsers, seedFootprints, cards } = input;

  const residentPlace = rng.pick(places);
  const others = places.filter((p) => p.id !== residentPlace.id);
  const awayPlaces = rng.shuffle(others.length > 0 ? others : [residentPlace]);
  const awayAt = (i: number) => awayPlaces[i % awayPlaces.length];

  const segments: Segment[] = [
    ...SCATTER_STATES.slice(0, DEV_SCATTER_COUNT).map(
      (state): Segment => ({ kind: "scatter", state }),
    ),
    { kind: "trip", index: 1, place: awayAt(0), states: [["PUBLIC", "APPROVED"], ["PUBLIC", "APPROVED"], ["PUBLIC", "APPROVED"]] },
    { kind: "trip", index: 2, place: awayAt(1), states: TRIP2_STATES },
    { kind: "loose", place: awayAt(2), states: LOOSE_STATES },
  ];
  const order = rng.shuffle(segments);

  const footprints: FootprintPlan[] = [];
  const photos: PhotoPlan[] = [];
  const trips: TripPlan[] = [];
  let cursor = rng.int(0, 20);
  let assetCursor = 0;
  let fpIndex = 0;

  const emit = (
    place: PlaceLite,
    dayIndex: number,
    [visibility, reviewStatus]: [Visibility, ReviewStatus],
    tripId: string | null,
    minPhotos: number,
    maxPhotos: number,
  ) => {
    fpIndex++;
    const id = `${SIM_PREFIX}fp-${fpIndex}`;
    const date = dateForDayIndex(dayIndex);
    const approvedPublic = visibility === "PUBLIC" && reviewStatus === "APPROVED";
    footprints.push({
      id,
      userId: devUserId,
      placeId: place.id,
      placeLat: place.lat,
      placeLng: place.lng,
      text: fillStory(rng.pick(STORY_TEMPLATES), place.name),
      date,
      visibility,
      reviewStatus,
      publicRequestedAt: visibility === "PUBLIC" ? date : null,
      viewCount: approvedPublic ? rng.int(20, VIEW_COUNT_MAX) : 0,
      likeCount: 0, // likesIn 规划阶段回填
      tripId,
    });
    const photoCount = rng.int(minPhotos, maxPhotos);
    for (let p = 0; p < photoCount; p++) {
      photos.push({
        id: `${SIM_PREFIX}ph-${fpIndex}-${p + 1}`,
        footprintId: id,
        uuid: rng.uuid(),
        assetIndex: assetCursor++,
        takenAt: date,
        lat: place.lat + (rng.next() - 0.5) * 0.02,
        lng: place.lng + (rng.next() - 0.5) * 0.02,
      });
    }
    return date;
  };

  for (const seg of order) {
    cursor += rng.int(3, 10); // 段间最小间隔，防止相邻段被误并成一个"行程"
    if (seg.kind === "scatter") {
      emit(residentPlace, cursor, seg.state, null, 0, 2);
    } else {
      const tripId = seg.kind === "trip" ? `${SIM_PREFIX}trip-${seg.index}` : null;
      let startDate: Date | null = null;
      let endDate: Date | null = null;
      for (let d = 0; d < seg.states.length; d++) {
        const date = emit(seg.place, cursor, seg.states[d], tripId, 1, 3);
        startDate ??= date;
        endDate = date;
        cursor += 1;
      }
      cursor -= 1; // 下一段的间隔以本段最后一天为基准
      if (seg.kind === "trip") {
        const y = startDate!.getUTCFullYear();
        const m = startDate!.getUTCMonth() + 1;
        trips.push({
          id: tripId!,
          title: `${seg.place.name}·${y}年${m}月`,
          placeId: seg.place.id,
          startDate: startDate!,
          endDate: endDate!,
        });
      }
    }
  }
  trips.sort((a, b) => (a.id < b.id ? -1 : 1)); // 输出顺序与段乱序解耦，保证确定性断言直观

  // seed 用户点亮 dev 的公开已过审足迹（likeCount 与 Like 行数保持一致）
  const likesIn: LikePlan[] = [];
  const devApproved = footprints.filter(
    (f) => f.visibility === "PUBLIC" && f.reviewStatus === "APPROVED",
  );
  for (let k = 0; k < devApproved.length; k++) {
    if (seedUsers.length === 0) break;
    const likerCount = rng.int(1, Math.min(DEV_MAX_LIKERS, seedUsers.length));
    const likers = rng.shuffle(seedUsers).slice(0, likerCount);
    likers.forEach((liker, j) => {
      likesIn.push({
        id: `${SIM_PREFIX}like-in-${k + 1}-${j + 1}`,
        userId: liker.id,
        footprintId: devApproved[k].id,
      });
    });
    devApproved[k].likeCount = likers.length;
  }

  // dev 也点赞别人的公开已过审足迹（与真实 API 的可点赞判据一致）
  const likable = seedFootprints.filter(
    (f) => f.visibility === "PUBLIC" && f.reviewStatus === "APPROVED",
  );
  const likesOut: LikePlan[] = rng
    .shuffle(likable)
    .slice(0, Math.min(DEV_LIKES_OUT_MAX, likable.length))
    .map((fp, k) => ({ id: `${SIM_PREFIX}like-out-${k + 1}`, userId: devUserId, footprintId: fp.id }));

  // dev 收藏若干存活卡片（shuffle+slice 保证 cardId 不重复）
  const favorites: FavoritePlan[] = rng
    .shuffle(cards)
    .slice(0, Math.min(DEV_FAVORITES_MAX, cards.length))
    .map((card, k) => ({ id: `${SIM_PREFIX}fav-dev-${k + 1}`, userId: devUserId, cardId: card.id }));

  return { trips, footprints, photos, likesIn, likesOut, favorites };
}
