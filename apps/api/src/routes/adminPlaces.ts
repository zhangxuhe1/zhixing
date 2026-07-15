import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "../auth.js";

const levelEnum = z.enum(["PROVINCE", "CITY", "DISTRICT", "POI"]);

const createPlaceSchema = z.object({
  name: z.string().min(1),
  level: levelEnum,
  parentId: z.string().nullish(),
  lat: z.number(),
  lng: z.number(),
  intro: z.string().optional(),
});

const linkCreateSchema = z.object({
  platform: z.enum(["XIAOHONGSHU", "BILIBILI", "DOUYIN", "WEIBO", "OTHER"]),
  title: z.string().trim().min(1).max(100),
  url: z.string().url().startsWith("https://").max(500),
  sortOrder: z.number().int().min(0).optional(),
});

const linkPatchSchema = linkCreateSchema.partial().refine(
  (v) => Object.values(v).some((x) => x !== undefined),
  { message: "at least one field required" },
);

const decisionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("approve"),
    name: z.string().trim().min(1).max(50).optional(),
    parentId: z.string().nullable().optional(),
  }),
  z.object({ action: z.literal("reject") }),
]);

const mergeSchema = z.object({ targetId: z.string() });

const LINK_SELECT = {
  id: true, platform: true, title: true, url: true, sortOrder: true,
} as const;

export async function adminPlacesRoutes(app: FastifyInstance) {
  // 自 places.ts 迁入,行为不变:管理员建点(官方录入)
  app.post("/admin/places", { preHandler: requireAdmin }, async (req, reply) => {
    const body = createPlaceSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    }
    const place = await app.prisma.place.create({
      data: { ...body.data, parentId: body.data.parentId ?? null },
    });
    return reply.code(201).send(place);
  });

  app.post("/admin/places/:id/links", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = linkCreateSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    }
    const place = await app.prisma.place.findUnique({ where: { id } });
    if (!place) return reply.code(404).send({ error: "not_found" });
    const link = await app.prisma.placeLink.create({
      data: { ...body.data, placeId: id },
      select: LINK_SELECT,
    });
    return reply.code(201).send(link);
  });

  app.patch("/admin/links/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = linkPatchSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    }
    const existing = await app.prisma.placeLink.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "not_found" });
    return app.prisma.placeLink.update({ where: { id }, data: body.data, select: LINK_SELECT });
  });

  app.delete("/admin/links/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await app.prisma.placeLink.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "not_found" });
    await app.prisma.placeLink.delete({ where: { id } });
    return reply.code(204).send();
  });

  app.get("/admin/places/pending", { preHandler: requireAdmin }, async () => {
    const rows = await app.prisma.place.findMany({
      where: { status: "PENDING" },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        lat: true,
        lng: true,
        createdAt: true,
        parent: { select: { id: true, name: true } },
        createdBy: { select: { nickname: true } },
      },
    });
    return {
      total: rows.length,
      items: rows.map((place) => ({
        id: place.id,
        name: place.name,
        lat: place.lat,
        lng: place.lng,
        createdAt: place.createdAt.toISOString(),
        parentId: place.parent?.id ?? null,
        parentName: place.parent?.name ?? null,
        creatorNickname: place.createdBy?.nickname ?? "(已注销)",
      })),
    };
  });

  app.post("/admin/places/:id/decision", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = decisionSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    }
    const place = await app.prisma.place.findUnique({ where: { id } });
    if (!place) return reply.code(404).send({ error: "not_found" });
    if (place.status !== "PENDING") {
      return reply.code(409).send({ error: "not_pending" });
    }

    if (body.data.action === "reject") {
      await app.prisma.place.update({ where: { id }, data: { status: "REJECTED" } });
      return reply.code(204).send();
    }

    // 通过时允许管理员修正自动猜测的名称与父级。
    const { name, parentId } = body.data;
    if (parentId != null) {
      const parent = await app.prisma.place.findUnique({ where: { id: parentId } });
      if (!parent || parent.id === id) {
        return reply.code(400).send({ error: "unknown_parent" });
      }
    }
    await app.prisma.place.update({
      where: { id },
      data: {
        status: "ACTIVE",
        ...(name !== undefined ? { name } : {}),
        ...(parentId !== undefined ? { parentId } : {}),
      },
    });
    return reply.code(204).send();
  });

  app.post("/admin/places/:id/merge", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = mergeSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    }
    const source = await app.prisma.place.findUnique({ where: { id } });
    if (!source) return reply.code(404).send({ error: "not_found" });
    if (source.status !== "PENDING") {
      return reply.code(409).send({ error: "not_pending" });
    }

    const target = await app.prisma.place.findUnique({ where: { id: body.data.targetId } });
    if (!target || target.id === id || target.status !== "ACTIVE") {
      return reply.code(400).send({ error: "invalid_target" });
    }

    // 防御性迁移 PENDING 点理论上不会承载的卡片、外链和子节点，事务完成后再删源点。
    await app.prisma.$transaction(async (tx) => {
      await tx.footprint.updateMany({ where: { placeId: id }, data: { placeId: target.id } });
      await tx.card.updateMany({ where: { placeId: id }, data: { placeId: target.id } });
      await tx.placeLink.updateMany({ where: { placeId: id }, data: { placeId: target.id } });
      await tx.place.updateMany({ where: { parentId: id }, data: { parentId: target.id } });
      await tx.place.delete({ where: { id } });
    });
    return reply.code(204).send();
  });
}
