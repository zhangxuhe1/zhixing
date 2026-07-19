import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "../auth.js";
import { placeAncestors } from "../placeAncestors.js";
import { placeSubtreeIds } from "../placeSubtree.js";

const blockSchema = z.object({
  type: z.enum(["TEXT", "IMAGE", "AUDIO", "VIDEO"]),
  text: z.string().optional(),
  mediaUrl: z.string().optional(),
});

const categoryEnum = z.enum(["CUSTOMS", "FOOD", "DIALECT", "ANECDOTE", "PLACE_NAME"]);

const createCardSchema = z.object({
  placeId: z.string(),
  category: categoryEnum,
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

const adminListQuerySchema = z.object({
  under: z.string().min(1).optional(),
  category: categoryEnum.optional(),
  status: z.enum(["AI_GENERATED", "REVIEWED", "RETIRED"]).optional(),
  q: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

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

  // 管理列表：子树/分类/状态/标题关键字筛选 + 分页；逐字段轻 DTO，不带 blocks
  app.get("/admin/cards", { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = adminListQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_query" });
    const { under, category, status, q, page, pageSize } = parsed.data;

    const keyword = q?.trim() ?? "";
    const where = {
      ...(under ? { placeId: { in: await placeSubtreeIds(app.prisma, under) } } : {}),
      ...(category ? { category } : {}),
      ...(status ? { status } : {}),
      ...(keyword !== ""
        ? { title: { contains: keyword, mode: "insensitive" as const } }
        : {}),
    };
    const [total, rows] = await Promise.all([
      app.prisma.card.count({ where }),
      app.prisma.card.findMany({
        where,
        include: { place: { select: { name: true } } },
        // 批量导入会撞 createdAt 时间戳，补 id 兜底保证翻页稳定
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return {
      total,
      items: rows.map((c) => ({
        id: c.id,
        title: c.title,
        category: c.category,
        status: c.status,
        createdAt: c.createdAt,
        placeId: c.placeId,
        placeName: c.place.name,
      })),
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
