import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "../auth.js";
import { placeAncestors } from "../placeAncestors.js";

const blockSchema = z.object({
  type: z.enum(["TEXT", "IMAGE", "AUDIO", "VIDEO"]),
  text: z.string().optional(),
  mediaUrl: z.string().optional(),
});

const createCardSchema = z.object({
  placeId: z.string(),
  category: z.enum(["CUSTOMS", "FOOD", "DIALECT", "ANECDOTE", "PLACE_NAME"]),
  title: z.string().min(1),
  sources: z.array(z.string()).default([]),
  blocks: z.array(blockSchema).min(1),
});

const patchCardSchema = z.object({
  title: z.string().min(1).optional(),
  sources: z.array(z.string()).optional(),
  blocks: z.array(blockSchema).min(1).optional(),
});

const statusSchema = z.object({ action: z.enum(["review", "retire"]) });

const includeBlocks = { blocks: { orderBy: { order: "asc" as const } } };

export async function cardsRoutes(app: FastifyInstance) {
  app.get("/places/:id/cards", async (req) => {
    const { id } = req.params as { id: string };
    return app.prisma.card.findMany({
      where: { placeId: id, status: { not: "RETIRED" } },
      include: includeBlocks,
      orderBy: { createdAt: "desc" },
    });
  });

  app.get("/cards/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const card = await app.prisma.card.findUnique({
      where: { id },
      include: { ...includeBlocks, place: true },
    });
    if (!card) return reply.code(404).send({ error: "not_found" });
    const { place, ...rest } = card;
    // 卡片详情需要显示位置路径：place 改为逐字段 DTO 并附祖先链(从远到近)
    return {
      ...rest,
      place: {
        id: place.id,
        name: place.name,
        level: place.level,
        lat: place.lat,
        lng: place.lng,
        ancestors: await placeAncestors(app.prisma, place.parentId),
      },
    };
  });

  app.post("/admin/cards", { preHandler: requireAdmin }, async (req, reply) => {
    const body = createCardSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    }
    const { blocks, ...rest } = body.data;
    const card = await app.prisma.card.create({
      data: {
        ...rest,
        blocks: { create: blocks.map((b, i) => ({ ...b, order: i })) },
      },
      include: includeBlocks,
    });
    return reply.code(201).send(card);
  });

  app.patch("/admin/cards/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = patchCardSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    }
    const existing = await app.prisma.card.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "not_found" });

    const { blocks, ...rest } = body.data;
    const card = await app.prisma.$transaction(async (tx) => {
      if (blocks) {
        await tx.cardBlock.deleteMany({ where: { cardId: id } });
        await tx.cardBlock.createMany({
          data: blocks.map((b, i) => ({ ...b, cardId: id, order: i })),
        });
      }
      return tx.card.update({ where: { id }, data: rest, include: includeBlocks });
    });
    return card;
  });

  app.post("/admin/cards/:id/status", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = statusSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });

    const card = await app.prisma.card.findUnique({ where: { id } });
    if (!card) return reply.code(404).send({ error: "not_found" });

    const { action } = body.data;
    // 状态机（规格书 §3.2）：AI_GENERATED --review--> REVIEWED；非 RETIRED --retire--> RETIRED
    if (action === "review" && card.status !== "AI_GENERATED") {
      return reply.code(409).send({ error: "invalid_transition", from: card.status });
    }
    if (action === "retire" && card.status === "RETIRED") {
      return reply.code(409).send({ error: "invalid_transition", from: card.status });
    }
    const status = action === "review" ? "REVIEWED" : "RETIRED";
    return app.prisma.card.update({ where: { id }, data: { status }, include: includeBlocks });
  });
}
