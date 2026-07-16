import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@zhixing/db";
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

export async function adminPlacesRoutes(app: FastifyInstance) {
  // 自 places.ts 迁入:管理员建点(官方录入)。加固:父级存在性与重名显式预检——
  // @@unique([name,parentId]) 在 parentId 为 NULL 时不生效(Postgres NULL≠NULL),
  // 且 FK/unique 违约直接抛会变 500,这里收敛为 400/409 业务错误。
  app.post("/admin/places", { preHandler: requireAdmin }, async (req, reply) => {
    const body = createPlaceSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    }
    const parentId = body.data.parentId ?? null;
    if (parentId !== null) {
      const parent = await app.prisma.place.findUnique({
        where: { id: parentId }, select: { id: true },
      });
      if (!parent) return reply.code(400).send({ error: "unknown_parent" });
    }
    const dup = await app.prisma.place.findFirst({
      where: { name: body.data.name, parentId }, select: { id: true },
    });
    if (dup) return reply.code(409).send({ error: "duplicate_name" });
    try {
      const place = await app.prisma.place.create({ data: { ...body.data, parentId } });
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
