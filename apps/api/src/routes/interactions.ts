import type { FastifyInstance } from "fastify";
import { Prisma } from "@zhixing/db";
import { requireUser } from "../auth.js";
import { PUBLICLY_VISIBLE } from "../visibility.js";

async function findVisibleFootprint(app: FastifyInstance, id: string) {
  return app.prisma.footprint.findFirst({ where: { id, ...PUBLICLY_VISIBLE }, select: { id: true } });
}

export async function interactionsRoutes(app: FastifyInstance) {
  app.put("/footprints/:id/like", { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const footprint = await findVisibleFootprint(app, id);
    if (!footprint) return reply.code(404).send({ error: "not_found" });

    try {
      await app.prisma.$transaction([
        app.prisma.like.create({ data: { userId: req.userId, footprintId: id } }),
        app.prisma.footprint.update({ where: { id }, data: { likeCount: { increment: 1 } } }),
      ]);
    } catch (err) {
      // 唯一冲突（已点过）视为幂等成功，不再自增
      if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) {
        throw err;
      }
    }
    return reply.code(204).send();
  });

  app.delete("/footprints/:id/like", { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const footprint = await findVisibleFootprint(app, id);
    if (!footprint) return reply.code(404).send({ error: "not_found" });

    await app.prisma.$transaction(async (tx) => {
      const { count } = await tx.like.deleteMany({ where: { userId: req.userId, footprintId: id } });
      if (count > 0) {
        await tx.footprint.update({ where: { id }, data: { likeCount: { decrement: 1 } } });
      }
    });
    return reply.code(204).send();
  });

  app.post("/footprints/:id/view", { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const footprint = await findVisibleFootprint(app, id);
    if (!footprint) return reply.code(404).send({ error: "not_found" });

    await app.prisma.footprint.update({ where: { id }, data: { viewCount: { increment: 1 } } });
    return reply.code(204).send();
  });
}
