import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth.js";

const createSchema = z.object({
  placeId: z.string(),
  text: z.string().max(2000).optional(),
  date: z.string().datetime({ offset: true }),
  visibility: z.enum(["PRIVATE", "PUBLIC"]).optional(),
});

const patchSchema = z
  .object({
    text: z.string().max(2000).nullable().optional(),
    date: z.string().datetime({ offset: true }).optional(),
    visibility: z.enum(["PRIVATE", "PUBLIC"]).optional(),
  })
  .refine((v) => v.text !== undefined || v.date !== undefined || v.visibility !== undefined, {
    message: "at least one field required",
  });

const includeShape = {
  place: { select: { id: true, name: true } },
  photos: { select: { id: true, takenAt: true } },
} as const;

type PlaceNode = { id: string; parentId: string | null; level: string };

export function rollup(placeIds: string[], byId: Map<string, PlaceNode>) {
  const cities = new Set<string>();
  const provinces = new Set<string>();
  for (const placeId of placeIds) {
    let city: string | null = null;
    let province: string | null = null;
    let top = placeId;
    let cur = byId.get(placeId);
    while (cur) {
      if (cur.level === "CITY") city = cur.id;
      if (cur.level === "PROVINCE") province = cur.id;
      top = cur.id;
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    cities.add(city ?? top);
    if (province) provinces.add(province);
  }
  return { cities: cities.size, provinces: provinces.size };
}

export async function footprintsRoutes(app: FastifyInstance) {
  app.post("/footprints", { preHandler: requireUser }, async (req, reply) => {
    const body = createSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    const place = await app.prisma.place.findUnique({ where: { id: body.data.placeId } });
    if (!place) return reply.code(400).send({ error: "unknown_place" });
    const isPublic = body.data.visibility === "PUBLIC";
    const footprint = await app.prisma.footprint.create({
      data: {
        userId: req.userId,
        placeId: body.data.placeId,
        text: body.data.text,
        date: new Date(body.data.date),
        visibility: body.data.visibility ?? "PRIVATE",
        reviewStatus: isPublic ? "PENDING" : undefined,
        publicRequestedAt: isPublic ? new Date() : undefined,
      },
      include: includeShape,
    });
    return reply.code(201).send(footprint);
  });

  app.patch("/footprints/:id", { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = patchSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });

    const existing = await app.prisma.footprint.findUnique({ where: { id } });
    if (!existing || existing.userId !== req.userId) {
      return reply.code(404).send({ error: "not_found" });
    }

    const { text, date, visibility } = body.data;
    let reviewStatus = existing.reviewStatus;
    let publicRequestedAt = existing.publicRequestedAt;

    if (visibility === "PUBLIC") {
      // 分支 1：切到 PUBLIC（无论原值）→ 重新进审核队列
      reviewStatus = "PENDING";
      publicRequestedAt = new Date();
    } else if (visibility === "PRIVATE") {
      // 分支 2：切到 PRIVATE → 只改 visibility，reviewStatus 原样保留
    } else if ((text !== undefined || date !== undefined) && existing.visibility === "PUBLIC") {
      // 分支 3：未动 visibility 但改了内容，且当前是公开态 → 防审后偷换
      reviewStatus = "PENDING";
      publicRequestedAt = new Date();
    }

    const footprint = await app.prisma.footprint.update({
      where: { id },
      data: {
        text,
        date: date !== undefined ? new Date(date) : undefined,
        visibility,
        reviewStatus,
        publicRequestedAt,
      },
      include: includeShape,
    });
    return reply.code(200).send(footprint);
  });

  app.get("/me/footprints", { preHandler: requireUser }, async (req) => {
    return app.prisma.footprint.findMany({
      where: { userId: req.userId },
      orderBy: { date: "desc" },
      include: includeShape,
    });
  });

  app.delete("/footprints/:id", { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const footprint = await app.prisma.footprint.findUnique({
      where: { id }, include: { photos: { select: { mediaUrl: true } } },
    });
    if (!footprint || footprint.userId !== req.userId) {
      return reply.code(404).send({ error: "not_found" });
    }
    await app.prisma.footprint.delete({ where: { id } }); // photos 级联删除
    app.storage.remove(footprint.photos.map((p) => p.mediaUrl)).catch(() => {
      app.log.warn({ id }, "storage cleanup failed");
    });
    return reply.code(204).send();
  });

  app.get("/me/stats", { preHandler: requireUser }, async (req) => {
    const [footprints, fpPlaces, places] = await Promise.all([
      app.prisma.footprint.count({ where: { userId: req.userId } }),
      app.prisma.footprint.findMany({
        where: { userId: req.userId }, select: { placeId: true }, distinct: ["placeId"],
      }),
      app.prisma.place.findMany({ select: { id: true, parentId: true, level: true } }),
    ]);
    const byId = new Map(places.map((p) => [p.id, p]));
    const placeIds = fpPlaces.map((f) => f.placeId);
    return { footprints, places: placeIds.length, ...rollup(placeIds, byId) };
  });
}
