import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@zhixing/db";
import { requireAdmin } from "../auth.js";

// name 上限 12 字:iOS 行内 chip 与管理端下拉的展示宽度约束
const tagCreateSchema = z.object({
  name: z.string().trim().min(1).max(12),
  sortOrder: z.number().int().min(0).optional(),
});

const tagPatchSchema = tagCreateSchema.partial().refine(
  (v) => Object.values(v).some((x) => x !== undefined),
  { message: "at least one field required" },
);

const TAG_DTO = { id: true, name: true, sortOrder: true } as const;

// 外链内容标签字典:运营自主增删改,免发版扩展分类。删除被引用标签在预检
// 与 FK Restrict(P2003)两层都收敛为 409,防误删静默丢标注。
export async function adminLinkTagsRoutes(app: FastifyInstance) {
  app.get("/admin/link-tags", { preHandler: requireAdmin }, async () => {
    const tags = await app.prisma.placeLinkTag.findMany({
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { ...TAG_DTO, _count: { select: { links: true } } },
    });
    return tags.map(({ _count, ...t }) => ({ ...t, linkCount: _count.links }));
  });

  app.post("/admin/link-tags", { preHandler: requireAdmin }, async (req, reply) => {
    const body = tagCreateSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    }
    try {
      const tag = await app.prisma.placeLinkTag.create({ data: body.data, select: TAG_DTO });
      return reply.code(201).send({ ...tag, linkCount: 0 });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return reply.code(409).send({ error: "duplicate_name" });
      }
      throw err;
    }
  });

  app.patch("/admin/link-tags/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = tagPatchSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    }
    const existing = await app.prisma.placeLinkTag.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return reply.code(404).send({ error: "not_found" });
    try {
      return await app.prisma.placeLinkTag.update({ where: { id }, data: body.data, select: TAG_DTO });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return reply.code(409).send({ error: "duplicate_name" });
      }
      throw err;
    }
  });

  app.delete("/admin/link-tags/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await app.prisma.placeLinkTag.findUnique({
      where: { id }, select: { _count: { select: { links: true } } },
    });
    if (!existing) return reply.code(404).send({ error: "not_found" });
    if (existing._count.links > 0) {
      return reply.code(409).send({ error: "tag_in_use", detail: { linkCount: existing._count.links } });
    }
    try {
      await app.prisma.placeLinkTag.delete({ where: { id } });
    } catch (err) {
      // 预检与删除之间被并发打标:FK Restrict 兜底,同样收敛为 409
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
        return reply.code(409).send({ error: "tag_in_use" });
      }
      throw err;
    }
    return reply.code(204).send();
  });
}
