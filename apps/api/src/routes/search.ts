import type { FastifyInstance } from "fastify";
import { requireAdmin } from "../auth.js";

export async function searchRoutes(app: FastifyInstance) {
  app.get("/search", async (req, reply) => {
    const { q } = req.query as { q?: string };
    const query = q?.trim() ?? "";
    if (!query) return reply.code(400).send({ error: "q_required" });

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
    const counts = await app.prisma.card.groupBy({
      by: ["placeId"],
      where: { placeId: { in: places.map((p) => p.id) }, status: { not: "RETIRED" } },
      _count: { _all: true },
    });
    const countBy = new Map(counts.map((c) => [c.placeId, c._count._all]));
    return places.map((p) => ({ ...p, cardCount: countBy.get(p.id) ?? 0 }));
  });

  app.get("/admin/search-misses", { preHandler: requireAdmin }, async () => {
    return app.prisma.searchMiss.findMany({ orderBy: { count: "desc" }, take: 100 });
  });
}
