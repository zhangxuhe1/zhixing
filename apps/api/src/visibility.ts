/**
 * 他人可见判据唯一入口：visibility=PUBLIC 且 reviewStatus=APPROVED。
 * 所有需要判断"对他人可见"的路由必须引用此常量，禁止手写重复条件。
 */
export const PUBLICLY_VISIBLE = { visibility: "PUBLIC", reviewStatus: "APPROVED" } as const;
