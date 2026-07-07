import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth.js";

const createReportSchema = z.object({
  text: z.string().min(1).max(500),
});

export async function reportsRoutes(app: FastifyInstance) {
  app.post("/cards/:id/report", { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = createReportSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    }

    const card = await app.prisma.card.findUnique({ where: { id }, select: { id: true } });
    if (!card) return reply.code(404).send({ error: "not_found" });

    const report = await app.prisma.cardReport.create({
      data: { cardId: id, userId: req.userId, text: body.data.text },
    });
    return reply.code(201).send({ id: report.id });
  });
}
