import type { FastifyInstance } from "fastify";
import { Prisma } from "@zhixing/db";
import { z } from "zod";
import { requireUser } from "../auth.js";

/**
 * 依据旅程剩余成员重算去规范化的 start/end；无成员则删除该 Trip。
 * 必须在事务内调用（与触发它的足迹增删改同一事务），保持范围/空态一致。
 */
async function recomputeTripRange(tx: Prisma.TransactionClient, tripId: string) {
  const members = await tx.footprint.findMany({
    where: { tripId },
    select: { date: true },
  });
  if (members.length === 0) {
    await tx.trip.delete({ where: { id: tripId } });
    return;
  }
  const times = members.map((m) => m.date.getTime());
  await tx.trip.update({
    where: { id: tripId },
    data: { startDate: new Date(Math.min(...times)), endDate: new Date(Math.max(...times)) },
  });
}

const createSchema = z.object({
  placeId: z.string(),
  text: z.string().max(2000).optional(),
  date: z.string().datetime({ offset: true }),
  visibility: z.enum(["PRIVATE", "PUBLIC"]).optional(),
});

const patchSchema = z
  .object({
    text: z.string().max(2000).nullable().optional(),
    date: z.string().datetime({ offset: true }).optional(),
    visibility: z.enum(["PRIVATE", "PUBLIC"]).optional(),
  })
  .refine((v) => v.text !== undefined || v.date !== undefined || v.visibility !== undefined, {
    message: "at least one field required",
  });

/**
 * 私密面足迹响应的唯一 select 形状：POST/PATCH/GET(/me/footprints) 三处共用，
 * 显式白名单字段，userId 等内部字段不外传。
 */
export const FOOTPRINT_SELECT = {
  id: true,
  placeId: true,
  text: true,
  date: true,
  visibility: true,
  reviewStatus: true,
  likeCount: true,
  viewCount: true,
  tripId: true,
  createdAt: true,
  place: { select: { id: true, name: true } },
  photos: { select: { id: true, takenAt: true } },
} as const;

/**
 * `/me/stats` 城市/省份归并统计（PG 递归 CTE，见路由内 SQL 注释）。
 * 语义镜像原纯 JS 版 rollup：沿 place.parentId 链从自身往上走，
 * 记录途中最后一个 CITY/PROVINCE 节点；无 CITY 祖先则退回链顶（parentId 为空的节点）计入 cities。
 */
type StatsRow = { places: number; cities: number; provinces: number };

export async function footprintsRoutes(app: FastifyInstance) {
  app.post("/footprints", { preHandler: requireUser }, async (req, reply) => {
    const body = createSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const place = await app.prisma.place.findUnique({ where: { id: body.data.placeId } });
    if (!place) return reply.code(400).send({ error: "unknown_place" });
    const isPublic = body.data.visibility === "PUBLIC";
    const footprint = await app.prisma.footprint.create({
      data: {
        userId: req.userId,
        placeId: body.data.placeId,
        text: body.data.text,
        date: new Date(body.data.date),
        visibility: body.data.visibility ?? "PRIVATE",
        reviewStatus: isPublic ? "PENDING" : undefined,
        publicRequestedAt: isPublic ? new Date() : undefined,
      },
      select: FOOTPRINT_SELECT,
    });
    return reply.code(201).send(footprint);
  });

  app.patch("/footprints/:id", { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = patchSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });

    const existing = await app.prisma.footprint.findUnique({ where: { id } });
    if (!existing || existing.userId !== req.userId) {
      return reply.code(404).send({ error: "not_found" });
    }

    const { text, date, visibility } = body.data;
    let reviewStatus = existing.reviewStatus;
    let publicRequestedAt = existing.publicRequestedAt;

    if (visibility === "PUBLIC") {
      // 分支 1：切到 PUBLIC（无论原值）→ 重新进审核队列
      reviewStatus = "PENDING";
      publicRequestedAt = new Date();
    } else if (visibility === "PRIVATE") {
      // 分支 2：切到 PRIVATE → 只改 visibility，reviewStatus 原样保留
    } else if ((text !== undefined || date !== undefined) && existing.visibility === "PUBLIC") {
      // 分支 3：未动 visibility 但改了内容，且当前是公开态 → 防审后偷换
      reviewStatus = "PENDING";
      publicRequestedAt = new Date();
    }

    // I1b：改了成员日期须重算所属旅程范围；与更新同一事务保证一致。
    const dateChanged =
      date !== undefined && new Date(date).getTime() !== existing.date.getTime();
    const footprint = await app.prisma.$transaction(async (tx) => {
      const updated = await tx.footprint.update({
        where: { id },
        data: {
          text,
          date: date !== undefined ? new Date(date) : undefined,
          visibility,
          reviewStatus,
          publicRequestedAt,
        },
        select: FOOTPRINT_SELECT,
      });
      if (dateChanged && existing.tripId) {
        await recomputeTripRange(tx, existing.tripId);
      }
      return updated;
    });
    return reply.code(200).send(footprint);
  });

  app.get("/me/footprints", { preHandler: requireUser }, async (req) => {
    return app.prisma.footprint.findMany({
      where: { userId: req.userId },
      orderBy: { date: "desc" },
      select: FOOTPRINT_SELECT,
    });
  });

  app.delete("/footprints/:id", { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const footprint = await app.prisma.footprint.findUnique({
      where: { id }, include: { photos: { select: { mediaUrl: true } } },
    });
    if (!footprint || footprint.userId !== req.userId) {
      return reply.code(404).send({ error: "not_found" });
    }
    const tripId = footprint.tripId;
    await app.prisma.$transaction(async (tx) => {
      await tx.footprint.delete({ where: { id } }); // photos 级联删除
      if (tripId) {
        // I1a：删掉的是旅程成员 → 用剩余成员重算 start/end；无成员则删掉 Trip 本身。
        await recomputeTripRange(tx, tripId);
      }
    });
    app.storage.remove(footprint.photos.map((p) => p.mediaUrl)).catch(() => {
      app.log.warn({ id }, "storage cleanup failed");
    });
    return reply.code(204).send();
  });

  app.get("/me/stats", { preHandler: requireUser }, async (req) => {
    const [footprints, rows] = await Promise.all([
      app.prisma.footprint.count({ where: { userId: req.userId } }),
      // 递归 CTE：从每个已访问 place 出发沿 parentId 链爬到链顶，depth 加安全上限
      // （树实际最深 4 层，10 纯属防呆），逐 origin 取"深度最大的 CITY/PROVINCE 祖先"
      // 及"链顶节点"，语义与原 JS rollup 一致：无 CITY 祖先则退回链顶计入 cities。
      // 相比旧实现（先 place.findMany 全表加载），这里只遍历用户实际访问过的地点的祖先链。
      app.prisma.$queryRaw<StatsRow[]>(Prisma.sql`
        WITH RECURSIVE origins AS (
          SELECT DISTINCT "placeId" AS origin FROM "Footprint" WHERE "userId" = ${req.userId}
        ),
        ancestry AS (
          SELECT o.origin, p.id, p."parentId", p.level, 0 AS depth
          FROM origins o
          JOIN "Place" p ON p.id = o.origin
          UNION ALL
          SELECT a.origin, p.id, p."parentId", p.level, a.depth + 1
          FROM ancestry a
          JOIN "Place" p ON p.id = a."parentId"
          WHERE a.depth < 10
        ),
        per_origin AS (
          SELECT
            origin,
            (array_agg(id ORDER BY depth DESC) FILTER (WHERE level = 'CITY'))[1] AS city_id,
            (array_agg(id ORDER BY depth DESC) FILTER (WHERE level = 'PROVINCE'))[1] AS province_id,
            (array_agg(id ORDER BY depth DESC))[1] AS top_id
          FROM ancestry
          GROUP BY origin
        )
        SELECT
          COUNT(*)::int AS places,
          COUNT(DISTINCT COALESCE(city_id, top_id))::int AS cities,
          COUNT(DISTINCT province_id)::int AS provinces
        FROM per_origin
      `),
    ]);
    const stats = rows[0] ?? { places: 0, cities: 0, provinces: 0 };
    return { footprints, places: stats.places, cities: stats.cities, provinces: stats.provinces };
  });
}
