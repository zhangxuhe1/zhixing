import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../auth.js";
import { countCardsByPlace } from "../placeCounts.js";

export async function searchRoutes(app: FastifyInstance) {
  app.get(
    "/search",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { q } = req.query as { q?: string };
      const query = q?.trim() ?? "";
      if (!query) return reply.code(400).send({ error: "q_required" });
      if (query.length > 64) return reply.code(400).send({ error: "query_too_long" });

      const places = await app.prisma.place.findMany({
        where: { name: { contains: query, mode: "insensitive" } },
        select: { id: true, name: true, level: true, parentId: true, lat: true, lng: true },
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
