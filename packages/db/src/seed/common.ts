/**
 * seed 各规划模块共享的基元：计划类型、日期锚点、对象键约定与 id 前缀。
 * 单独成文件是为了让 index.ts（编排）与 extras.ts（扩展规划）保持单向依赖，避免 ESM 循环导入。
 */
import type { Place as PlaceRow } from "../index.js";

export type Visibility = "PUBLIC" | "PRIVATE";
export type ReviewStatus = "PENDING" | "APPROVED" | "REJECTED";

export interface UserPlan {
  id: string;
  /** APPLE 身份的 subject（历史字段名保留）：落库时写入 Identity.subject，不再写 user.appleSub。 */
  appleSub: string;
  nickname: string;
}

export interface FootprintPlan {
  id: string;
  userId: string;
  placeId: string;
  placeLat: number;
  placeLng: number;
  text: string;
  date: Date;
  visibility: Visibility;
  reviewStatus: ReviewStatus;
  publicRequestedAt: Date | null;
  viewCount: number;
  likeCount: number;
  /** 归属行程；rich/sparse 档不产生行程，仅 dev 账号计划使用。缺省视为 null。 */
  tripId?: string | null;
}

export interface PhotoPlan {
  id: string;
  footprintId: string;
  uuid: string;
  assetIndex: number;
  takenAt: Date;
  lat: number;
  lng: number;
}

export interface LikePlan {
  id: string;
  userId: string;
  footprintId: string;
}

export interface SeedPlan {
  users: UserPlan[];
  footprints: FootprintPlan[];
  photos: PhotoPlan[];
  likes: LikePlan[];
}

export type PlaceLite = Pick<PlaceRow, "id" | "name" | "lat" | "lng">;

/** rich/sparse 档 seed 用户的 APPLE 身份 subject 前缀，wipe 经 (APPLE, subject 前缀) 的 Identity 圈定。 */
export const SEED_PREFIX = "seed-";
/** 扩展数据（dev 账号个人数据、卡片收藏/举报）的行 id 前缀，wipe 以此圈定扩展行。 */
export const SIM_PREFIX = "sim-";

/** photos/{footprintId}/{uuid}.jpg —— 与 apps/api/src/routes/photos.ts 的对象键约定一致。 */
export function photoObjectKey(footprintId: string, uuid: string): string {
  return `photos/${footprintId}/${uuid}.jpg`;
}

export const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** 固定锚点（非当前时间）：保证同一份 Place 数据下，重跑 seed 产出逐字节相同的日期。 */
const DAY0_UTC_MS = Date.UTC(2025, 0, 1);

/** 第 dayIndex 天（从固定锚点起算）的 CST 10:00 时刻，即 UTC 02:00——契约要求的"旅行簇"日历语义。 */
export function dateForDayIndex(dayIndex: number): Date {
  const midnightUtc = DAY0_UTC_MS + dayIndex * MS_PER_DAY;
  return new Date(midnightUtc + 2 * 60 * 60 * 1000);
}

/** 各档共用：viewCount 随机上限。 */
export const VIEW_COUNT_MAX = 200;
