import type { FastifyInstance } from "fastify";
import { Prisma } from "@zhixing/db";
import { requireUser } from "../auth.js";

export async function favoritesRoutes(app: FastifyInstance) {
  app.put("/cards/:id/favorite", { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const card = await app.prisma.card.findUnique({ where: { id }, select: { id: true } });
    if (!card) return reply.code(404).send({ error: "not_found" });

    try {
      await app.prisma.cardFavorite.create({ data: { userId: req.userId, cardId: id } });
    } catch (err) {
      // 唯一冲突（已收藏过）视为幂等成功
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) {
        throw err;
      }
    }
    return reply.code(204).send();
  });

  app.delete("/cards/:id/favorite", { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const card = await app.prisma.card.findUnique({ where: { id }, select: { id: true } });
    if (!card) return reply.code(404).send({ error: "not_found" });

    await app.prisma.cardFavorite.deleteMany({ where: { userId: req.userId, cardId: id } });
    return reply.code(204).send();
  });

  app.get("/me/favorites", { preHandler: requireUser }, async (req) => {
    const favorites = await app.prisma.cardFavorite.findMany({
      where: { userId: req.userId },
      include: { card: { include: { place: true } } },
      orderBy: { createdAt: "desc" },
    });
    return {
      items: favorites.map((f) => ({
        cardId: f.card.id,
        title: f.card.title,
        category: f.card.category,
        placeId: f.card.placeId,
        placeName: f.card.place.name,
        favoritedAt: f.createdAt,
      })),
    };
  });
}
