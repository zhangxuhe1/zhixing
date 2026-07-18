import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "../auth.js";
import { PHOTO_ORDER_BY } from "./photos.js";

const reviewActionSchema = z.object({ action: z.enum(["approve", "reject"]) });

const reportsQuerySchema = z.object({
  status: z.enum(["OPEN", "RESOLVED"]).optional(),
});

const reportStatusSchema = z.object({ status: z.literal("RESOLVED") });

const reviewQueueSelect = {
  id: true,
  text: true,
  date: true,
  publicRequestedAt: true,
  user: { select: { nickname: true } },
  place: { select: { name: true } },
  // 审核队列照片序与用户端一致。
  photos: { select: { id: true, mediaUrl: true }, orderBy: PHOTO_ORDER_BY },
} as const;

export async function adminReviewRoutes(app: FastifyInstance) {
  app.get("/admin/review-queue", { preHandler: requireAdmin }, async () => {
    const rows = await app.prisma.footprint.findMany({
      where: { visibility: "PUBLIC", reviewStatus: "PENDING" },
      orderBy: { publicRequestedAt: "asc" },
      select: reviewQueueSelect,
    });

    const items = await Promise.all(
      rows.map(async (fp) => ({
        footprintId: fp.id,
        text: fp.text,
        date: fp.date.toISOString(),
        authorNickname: fp.user.nickname,
        placeName: fp.place.name,
        publicRequestedAt: fp.publicRequestedAt?.toISOString() ?? null,
        photos: await Promise.all(
          fp.photos.map(async (p) => ({
            photoId: p.id,
            url: await app.storage.presignGet(p.mediaUrl, 300),
          })),
        ),
      })),
    );

    return { total: items.length, items };
  });

  app.post("/admin/review/:footprintId", { preHandler: requireAdmin }, async (req, reply) => {
    const { footprintId } = req.params as { footprintId: string };
    const body = reviewActionSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    }

    const footprint = await app.prisma.footprint.findUnique({ where: { id: footprintId } });
    if (!footprint) return reply.code(404).send({ error: "not_found" });
    if (footprint.visibility !== "PUBLIC" || footprint.reviewStatus !== "PENDING") {
      return reply.code(409).send({ error: "not_pending" });
    }

    const reviewStatus = body.data.action === "approve" ? "APPROVED" : "REJECTED";
    await app.prisma.footprint.update({ where: { id: footprintId }, data: { reviewStatus } });
    return reply.code(204).send();
  });

  app.get("/admin/reports", { preHandler: requireAdmin }, async (req, reply) => {
    const q = reportsQuerySchema.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query", detail: q.error.flatten() });

    const reports = await app.prisma.cardReport.findMany({
      where: { status: q.data.status ?? "OPEN" },
      orderBy: { createdAt: "desc" },
      include: { card: { select: { title: true } } },
    });

    return {
      items: reports.map((r) => ({
        id: r.id,
        cardId: r.cardId,
        cardTitle: r.card.title,
        text: r.text,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });

  app.patch("/admin/reports/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = reportStatusSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });

    const existing = await app.prisma.cardReport.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "not_found" });

    await app.prisma.cardReport.update({ where: { id }, data: { status: body.data.status } });
    return reply.code(204).send();
  });
}
