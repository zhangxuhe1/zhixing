/**
 * 他人可见判据唯一入口：visibility=PUBLIC 且 reviewStatus=APPROVED。
 * 所有需要判断"对他人可见"的路由必须引用此常量，禁止手写重复条件。
 */
export const PUBLICLY_VISIBLE = { visibility: "PUBLIC", reviewStatus: "APPROVED" } as const;

/** 地点公开判据:仅 ACTIVE 对所有人可见。公开面(public.ts 等)一律引用它。 */
export const PLACE_ACTIVE = { status: "ACTIVE" } as const;

/** 用户面地点可见判据:ACTIVE,或本人创建(含待审 PENDING 与驳回 REJECTED——驳回点
 *  仍要在地图上可见,否则其上足迹成孤儿)。匿名等同"只见 ACTIVE"。 */
export function placeVisibleTo(userId: string | null) {
  return userId
    ? { OR: [{ status: "ACTIVE" as const }, { createdById: userId }] }
    : PLACE_ACTIVE;
}

/** 搜索/选点判据:比可见收窄——REJECTED 不进搜索结果,避免引导用户往驳回点上继续挂足迹。 */
export function placeSearchableTo(userId: string | null) {
  return userId
    ? { OR: [{ status: "ACTIVE" as const }, { status: "PENDING" as const, createdById: userId }] }
    : PLACE_ACTIVE;
}
