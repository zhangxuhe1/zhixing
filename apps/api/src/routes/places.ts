import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { optionalUser, requireAdmin, requireUser } from "../auth.js";
import { haversineMeters } from "../geo.js";
import { countCardsByPlace } from "../placeCounts.js";
import { placeAncestors } from "../placeAncestors.js";
import { placeVisibleTo } from "../visibility.js";

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

/** 用户申请新地点的运营参数,集中一处便于调整:
 *  dailyLimit——每用户 24 小时滚动窗建点上限;parentRadiusMeters——父级自动猜半径。 */
const PLACE_SUBMISSION = { dailyLimit: 10, parentRadiusMeters: 150_000 } as const;

const submitPlaceSchema = z.object({
  name: z.string().trim().min(1).max(50),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

async function queryPins(app: FastifyInstance, userId: string | null) {
  const places = await app.prisma.place.findMany({
    where: placeVisibleTo(userId),
    select: { id: true, name: true, level: true, parentId: true, lat: true, lng: true, status: true },
    orderBy: { createdAt: "asc" },
  });
  const countBy = await countCardsByPlace(app.prisma, places.map((p) => p.id));
  return places.map((p) => ({ ...p, cardCount: countBy.get(p.id) ?? 0 }));
}

export async function placesRoutes(app: FastifyInstance) {
  app.get(
    "/places/pins",
    { config: ipKeyedRateLimit, preHandler: optionalUser },
    async (req) => queryPins(app, req.optionalUserId),
  );

  app.get("/places/random", { config: ipKeyedRateLimit }, async (_req, reply) => {
    // 随机漫步是公开发现功能:只在 ACTIVE 且有内容的地点里抽,与登录态无关
    const withContent = (await queryPins(app, null)).filter((p) => p.cardCount > 0);
    if (withContent.length === 0) return reply.code(404).send({ error: "no_content" });
    const pick = withContent[Math.floor(Math.random() * withContent.length)];
    return { ...pick, ancestors: await placeAncestors(app.prisma, pick.parentId) };
  });

  app.get("/places", { preHandler: requireAdmin }, async (req, reply) => {
    const q = listQuerySchema.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    return app.prisma.place.findMany({
      where: { level: q.data.level, parentId: q.data.parentId },
      orderBy: { createdAt: "asc" },
    });
  });

  app.get("/places/:id", { preHandler: optionalUser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const place = await app.prisma.place.findFirst({
      where: { id, AND: [placeVisibleTo(req.optionalUserId)] },
      include: { links: { orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }] } },
    });
    if (!place) return reply.code(404).send({ error: "not_found" });
    return {
      id: place.id,
      name: place.name,
      level: place.level,
      lat: place.lat,
      lng: place.lng,
      intro: place.intro,
      status: place.status,
      ancestors: await placeAncestors(app.prisma, place.parentId),
      links: place.links.map((l) => ({
        id: l.id, platform: l.platform, title: l.title, url: l.url, sortOrder: l.sortOrder,
      })),
    };
  });

  app.post("/places", { preHandler: requireUser }, async (req, reply) => {
    // 开关硬校验:客户端藏按钮只是体验,授权在服务端
    if (!app.placeSubmission) {
      return reply.code(403).send({ error: "place_submission_disabled" });
    }
    const body = submitPlaceSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    }

    // 防滥用:24 小时滚动窗上限(不按自然日,免时区口径之争)
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recent = await app.prisma.place.count({
      where: { createdById: req.userId, createdAt: { gte: dayAgo } },
    });
    if (recent >= PLACE_SUBMISSION.dailyLimit) {
      return reply.code(429).send({ error: "daily_limit" });
    }

    // 父级自动猜:最近的"城市级"节点。候选 = CITY,加上"无市级子节点的 PROVINCE"
    // (直辖市/特区:北京下面直接是街区)。真正的省(山东省,有 CITY 子节点)不收编落点。
    const candidates = await app.prisma.place.findMany({
      where: {
        status: "ACTIVE",
        OR: [
          { level: "CITY" },
          { level: "PROVINCE", children: { none: { level: "CITY" } } },
        ],
      },
      select: { id: true, lat: true, lng: true },
    });
    let parentId: string | null = null;
    let best: number = PLACE_SUBMISSION.parentRadiusMeters;
    for (const c of candidates) {
      const d = haversineMeters(body.data.lat, body.data.lng, c.lat, c.lng);
      if (d <= best) {
        best = d;
        parentId = c.id;
      }
    }

    // 同名同父即重复:回 409 引导直接选用已有地点(这本身就是防重复录入)
    const dup = await app.prisma.place.findFirst({
      where: { name: body.data.name, parentId },
      select: { id: true },
    });
    if (dup) return reply.code(409).send({ error: "place_exists", placeId: dup.id });

    try {
      const place = await app.prisma.place.create({
        data: {
          name: body.data.name,
          level: "POI",
          parentId,
          lat: body.data.lat,
          lng: body.data.lng,
          status: "PENDING",
          createdById: req.userId,
        },
      });
      // Pin 形状 DTO:iOS 直接当 Pin 用;createdById 不外传
      return reply.code(201).send({
        id: place.id, name: place.name, level: place.level, parentId: place.parentId,
        lat: place.lat, lng: place.lng, status: place.status, cardCount: 0,
      });
    } catch (e) {
      // 并发撞唯一键(name,parentId):按已存在处理
      if (e && typeof e === "object" && "code" in e && e.code === "P2002") {
        const race = await app.prisma.place.findFirst({
          where: { name: body.data.name, parentId },
          select: { id: true },
        });
        return reply.code(409).send({ error: "place_exists", placeId: race?.id ?? null });
      }
      throw e;
    }
  });
}
