import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@zhixing/db";
import { requireAdmin } from "../auth.js";

const levelEnum = z.enum(["PROVINCE", "CITY", "DISTRICT", "POI"]);

const ancestorSchema = z.object({
  name: z.string().trim().min(1),
  level: z.enum(["PROVINCE", "CITY"]),
  lat: z.number().optional(),
  lng: z.number().optional(),
});

const createPlaceSchema = z.object({
  name: z.string().min(1),
  level: levelEnum,
  parentId: z.string().nullish(),
  ancestors: z.array(ancestorSchema).min(1).max(2).optional(),
  lat: z.number(),
  lng: z.number(),
  intro: z.string().optional(),
});

const patchPlaceSchema = z
  .object({
    name: z.string().min(1),
    level: levelEnum,
    parentId: z.string().nullable(),
    lat: z.number(),
    lng: z.number(),
    intro: z.string().nullable(),
  })
  .partial()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: "at least one field required",
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

const LINK_SELECT = {
  id: true, platform: true, title: true, url: true, sortOrder: true,
} as const;

// 沿父链上溯,命中自身即成环。树深≤4,32 跳保险丝防御脏数据下的死循环。
async function reachesSelf(
  prisma: FastifyInstance["prisma"], id: string, fromParentId: string,
): Promise<boolean> {
  let cur: string | null = fromParentId;
  for (let hops = 0; cur !== null; hops++) {
    if (cur === id || hops >= 32) return true;
    const p: { parentId: string | null } | null = await prisma.place.findUnique({
      where: { id: cur }, select: { parentId: true },
    });
    if (!p) return false;
    cur = p.parentId;
  }
  return false;
}

// 祖先链 find-or-create:链顶在前([省] 或 [省,市];直辖市/特区只传单个省级节点)。
// 只复用不修改——同名命中时不动既有节点的 level/坐标;新建时坐标缺省回落到子点位
// 坐标(必在正确行政区内,后续可在管理端修正)。并发竞态:非链顶撞 P2002 用
// name_parentId 回查;链顶无 unique(NULL≠NULL)不加锁,窄竞态下的重复链顶可改父收敛。
async function resolveAncestors(
  prisma: FastifyInstance["prisma"],
  ancestors: z.infer<typeof ancestorSchema>[],
  fallback: { lat: number; lng: number },
): Promise<string> {
  let parentId: string | null = null;
  for (const a of ancestors) {
    const found = await prisma.place.findFirst({
      where: { name: a.name, parentId }, select: { id: true },
    });
    if (found) { parentId = found.id; continue; }
    try {
      const created = await prisma.place.create({
        data: {
          name: a.name, level: a.level, parentId,
          lat: a.lat ?? fallback.lat, lng: a.lng ?? fallback.lng,
        },
        select: { id: true },
      });
      parentId = created.id;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002" && parentId !== null
      ) {
        const raced = await prisma.place.findUnique({
          where: { name_parentId: { name: a.name, parentId } }, select: { id: true },
        });
        if (raced) { parentId = raced.id; continue; }
      }
      throw err;
    }
  }
  // zod min(1) 保证至少一跳,循环后必非 null
  return parentId!;
}

export async function adminPlacesRoutes(app: FastifyInstance) {
  // 自 places.ts 迁入:管理员建点(官方录入)。加固:父级存在性与重名显式预检——
  // @@unique([name,parentId]) 在 parentId 为 NULL 时不生效(Postgres NULL≠NULL),
  // 且 FK/unique 违约直接抛会变 500,这里收敛为 400/409 业务错误。
  // 可选 ancestors(与非空 parentId 互斥):高德识别出的省市链,经 resolveAncestors
  // 幂等挂链后作为最终 parentId,管理端由此免手工维护省市树。
  app.post("/admin/places", { preHandler: requireAdmin }, async (req, reply) => {
    const body = createPlaceSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    }
    const { ancestors, ...data } = body.data;
    let parentId = data.parentId ?? null;
    if (ancestors) {
      // 两种父级来源互斥,避免"听谁的"歧义
      if (parentId !== null) return reply.code(400).send({ error: "conflicting_parent" });
      if (
        ancestors[0].level !== "PROVINCE" ||
        (ancestors.length === 2 &&
          (ancestors[1].level !== "CITY" || ancestors[1].name === ancestors[0].name))
      ) {
        return reply.code(400).send({ error: "invalid_ancestors" });
      }
      // 后续重名 409 时已建的省市节点会留下——本就是合法行政区节点,重试直接复用
      parentId = await resolveAncestors(app.prisma, ancestors, {
        lat: data.lat, lng: data.lng,
      });
    } else if (parentId !== null) {
      const parent = await app.prisma.place.findUnique({
        where: { id: parentId }, select: { id: true },
      });
      if (!parent) return reply.code(400).send({ error: "unknown_parent" });
    }
    const dup = await app.prisma.place.findFirst({
      where: { name: data.name, parentId }, select: { id: true },
    });
    if (dup) return reply.code(409).send({ error: "duplicate_name" });
    try {
      const place = await app.prisma.place.create({ data: { ...data, parentId } });
      return reply.code(201).send(place);
    } catch (err) {
      // 预检与写入之间的并发竞态兜底
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return reply.code(409).send({ error: "duplicate_name" });
      }
      throw err;
    }
  });

  // 管理员编辑地点:改名/改简介/改坐标(GCJ-02)/改父/改层级。层级搭配不强校验
  // (与 POST 一致,正确性交给管理员);改父需防树环,否则足迹页递归 CTE 死循环。
  app.patch("/admin/places/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = patchPlaceSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    }
    const current = await app.prisma.place.findUnique({ where: { id } });
    if (!current) return reply.code(404).send({ error: "not_found" });

    const nextParentId =
      body.data.parentId === undefined ? current.parentId : body.data.parentId;
    if (nextParentId !== current.parentId && nextParentId !== null) {
      const parent = await app.prisma.place.findUnique({
        where: { id: nextParentId }, select: { id: true },
      });
      if (!parent) return reply.code(400).send({ error: "unknown_parent" });
    }
    if (nextParentId !== null && nextParentId !== current.parentId) {
      if (await reachesSelf(app.prisma, id, nextParentId)) {
        return reply.code(400).send({ error: "cyclic_parent" });
      }
    }
    // 自指(parentId === id)也属成环:上面的分支在 nextParentId === id 时必然
    // 与 current.parentId 不同,reachesSelf 首跳即命中,无需单独判。
    const nextName = body.data.name ?? current.name;
    if (nextName !== current.name || nextParentId !== current.parentId) {
      const dup = await app.prisma.place.findFirst({
        where: { name: nextName, parentId: nextParentId, NOT: { id } },
        select: { id: true },
      });
      if (dup) return reply.code(409).send({ error: "duplicate_name" });
    }
    try {
      return await app.prisma.place.update({ where: { id }, data: body.data });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return reply.code(409).send({ error: "duplicate_name" });
      }
      throw err;
    }
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
}
