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
  name: z.string().trim().min(1),
  level: levelEnum,
  parentId: z.string().nullish(),
  ancestors: z.array(ancestorSchema).min(1).max(2).optional(),
  lat: z.number(),
  lng: z.number(),
  intro: z.string().optional(),
});

const patchPlaceSchema = z
  .object({
    name: z.string().trim().min(1),
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

// 创建新祖先必须省市各带完整坐标:iOS 照片匹配按 距离/半径 打分(市级半径 30km),
// 新市若落在点位坐标上会永远抢赢点位本身,静默毒化整片匹配——宁可显式报错。
class AncestorCoordsError extends Error {
  constructor(public ancestorName: string) {
    super("ancestor_coords_required");
  }
}

// 祖先链 find-or-create:链顶在前([省] 或 [省,市];直辖市/特区只传单个省级节点)。
// 命中同名节点只复用不修改;唯一的写入例外是"补挂"——同名遗留链顶(老库/手工把市
// 建成无父级)收编到省下,与 import-regions 的迁移分支同语义:只改 parentId+level,
// 坐标不动,不建重复市。并发竞态:创建或收编撞 name_parentId 唯一约束时回查复用;
// 链顶无该约束(NULL≠NULL)不加锁,窄竞态下的重复链顶由补挂按最老优先逐步收敛。
async function resolveAncestors(
  prisma: FastifyInstance["prisma"],
  ancestors: z.infer<typeof ancestorSchema>[],
): Promise<string> {
  let parentId: string | null = null;
  for (const a of ancestors) {
    const found = await prisma.place.findFirst({
      where: { name: a.name, parentId }, select: { id: true },
    });
    if (found) { parentId = found.id; continue; }
    try {
      if (parentId !== null) {
        // 补挂:多个同名链顶取最老者(最可能挂着存量内容);reachesSelf 防跨请求
        // 互挂成环——树环会让 trips 的 resolveCity 死循环,命中则放弃收编退回新建
        const legacy = await prisma.place.findFirst({
          where: { name: a.name, parentId: null },
          orderBy: [{ createdAt: "asc" }, { id: "asc" }],
          select: { id: true },
        });
        if (legacy && !(await reachesSelf(prisma, legacy.id, parentId))) {
          await prisma.place.update({
            where: { id: legacy.id }, data: { parentId, level: a.level },
          });
          parentId = legacy.id;
          continue;
        }
      }
      if (a.lat === undefined || a.lng === undefined) {
        throw new AncestorCoordsError(a.name);
      }
      const created = await prisma.place.create({
        data: { name: a.name, level: a.level, parentId, lat: a.lat, lng: a.lng },
        select: { id: true },
      });
      parentId = created.id;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002" && parentId !== null
      ) {
        // create 撞已有,或收编 update 撞并发新建:都按 name_parentId 回查复用
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
      // 后续重名 409 时已建/已收编的省市节点会留下——本就是合法修复性写入,重试直接复用
      try {
        parentId = await resolveAncestors(app.prisma, ancestors);
      } catch (err) {
        if (err instanceof AncestorCoordsError) {
          return reply.code(400).send({
            error: "ancestor_coords_required", detail: { name: err.ancestorName },
          });
        }
        throw err;
      }
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
