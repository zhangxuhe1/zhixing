import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireAdmin } from "../auth.js";
import { countCardsByPlace } from "../placeCounts.js";
import { placeAncestors } from "../placeAncestors.js";

// pins/random 未鉴权且是重查询（全量地点 + 卡数聚合），同样受全局 keyGenerator
// "有 Authorization 头就按头计费"的伪造绕过影响——覆盖为按 req.ip 计数；不传 max/
// timeWindow，@fastify/rate-limit 按路由 config 与全局配置合并，自动继承全局档位。
const ipKeyedRateLimit = {
  rateLimit: { keyGenerator: (req: FastifyRequest) => req.ip },
};

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

async function queryPins(app: FastifyInstance) {
  const places = await app.prisma.place.findMany({
    select: { id: true, name: true, level: true, parentId: true, lat: true, lng: true },
    orderBy: { createdAt: "asc" },
  });
  const countBy = await countCardsByPlace(app.prisma, places.map((p) => p.id));
  return places.map((p) => ({ ...p, cardCount: countBy.get(p.id) ?? 0 }));
}

export async function placesRoutes(app: FastifyInstance) {
  app.get("/places/pins", { config: ipKeyedRateLimit }, async () => queryPins(app));

  app.get("/places/random", { config: ipKeyedRateLimit }, async (_req, reply) => {
    const withContent = (await queryPins(app)).filter((p) => p.cardCount > 0);
    if (withContent.length === 0) return reply.code(404).send({ error: "no_content" });
    const pick = withContent[Math.floor(Math.random() * withContent.length)];
    return { ...pick, ancestors: await placeAncestors(app.prisma, pick.parentId) };
  });

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
    const place = await app.prisma.place.findUnique({ where: { id } });
    if (!place) return reply.code(404).send({ error: "not_found" });
    // 逐字段 DTO：children 自 M3 移除(全库无消费方)，createdAt/parentId 不外传
    return {
      id: place.id,
      name: place.name,
      level: place.level,
      lat: place.lat,
      lng: place.lng,
      intro: place.intro,
      ancestors: await placeAncestors(app.prisma, place.parentId),
    };
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
