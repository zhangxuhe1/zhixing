import type { FastifyInstance, FastifyRequest } from "fastify";
import { optionalUser, requireAdmin } from "../auth.js";
import { countCardsByPlace } from "../placeCounts.js";
import { placeSearchableTo } from "../visibility.js";

// /search 未鉴权，全局 keyGenerator 在有 Authorization 头时按头计费——攻击者可给每次
// 请求都塞一个随机头骗出新桶，绕开 30/min 限流刷查询。这里显式覆盖为按 req.ip 计数。
const searchRateLimit = {
  rateLimit: { max: 30, timeWindow: "1 minute", keyGenerator: (req: FastifyRequest) => req.ip },
};

export async function searchRoutes(app: FastifyInstance) {
  app.get(
    "/search",
    { config: searchRateLimit, preHandler: optionalUser },
    async (req, reply) => {
      const { q } = req.query as { q?: string };
      const query = q?.trim() ?? "";
      if (!query) return reply.code(400).send({ error: "q_required" });
      if (query.length > 64) return reply.code(400).send({ error: "query_too_long" });

      const places = await app.prisma.place.findMany({
        where: {
          name: { contains: query, mode: "insensitive" },
          AND: [placeSearchableTo(req.optionalUserId)],
        },
        select: { id: true, name: true, level: true, parentId: true, lat: true, lng: true, status: true },
        take: 20,
      });
      if (places.length === 0) {
        await app.prisma.searchMiss.upsert({
          where: { query },
          update: { count: { increment: 1 } },
          create: { query },
        });
        return [];
      }
      const countBy = await countCardsByPlace(app.prisma, places.map((p) => p.id));
      return places.map((p) => ({ ...p, cardCount: countBy.get(p.id) ?? 0 }));
    },
  );

  app.get("/admin/search-misses", { preHandler: requireAdmin }, async () => {
    return app.prisma.searchMiss.findMany({ orderBy: { count: "desc" }, take: 100 });
  });
}
