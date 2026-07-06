import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "../auth.js";

const levelEnum = z.enum(["PROVINCE", "CITY", "DISTRICT", "POI"]);

const listQuerySchema = z.object({
  level: levelEnum.optional(),
  parentId: z.string().optional(),
});

const createPlaceSchema = z.object({
  name: z.string().min(1),
  level: levelEnum,
  parentId: z.string().nullish(),
  lat: z.number(),
  lng: z.number(),
  intro: z.string().optional(),
});

export async function placesRoutes(app: FastifyInstance) {
  app.get("/places", async (req, reply) => {
    const q = listQuerySchema.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    return app.prisma.place.findMany({
      where: { level: q.data.level, parentId: q.data.parentId },
      orderBy: { createdAt: "asc" },
    });
  });

  app.get("/places/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const place = await app.prisma.place.findUnique({
      where: { id },
      include: { children: true },
    });
    if (!place) return reply.code(404).send({ error: "not_found" });
    return place;
  });

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
}
