import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { MultipartFields } from "@fastify/multipart";
import type { Prisma } from "@zhixing/db";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { PUBLICLY_VISIBLE } from "../visibility.js";

/**
 * 照片读取顺序的唯一权威：orderIndex 升序、id 兜底（存量 orderIndex 全 0 时保持稳定创建序）。
 * 私密面 / 公开故事 / 照片墙 / 审核队列四处 photos 子查询共用，不得各自手写。
 */
export const PHOTO_ORDER_BY: Prisma.FootprintPhotoOrderByWithRelationInput[] = [
  { orderIndex: "asc" },
  { id: "asc" },
];

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
};

/** 照片 meta 字段（均可选，缺省即不带定位/拍摄时间）；越界或格式错一律 400 invalid_photo_meta。 */
const photoMetaSchema = z.object({
  takenAt: z.string().datetime({ offset: true }).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
});

/** 重排 body：不加 min(1)——0 张足迹 + 空数组是合法的 204 no-op。 */
const reorderSchema = z.object({ photoIds: z.array(z.string()) });

function fieldValue(fields: MultipartFields, name: string): string | undefined {
  const f = fields[name];
  const single = Array.isArray(f) ? f[0] : f;
  return single && single.type === "field" && typeof single.value === "string"
    ? single.value
    : undefined;
}

export async function photosRoutes(app: FastifyInstance) {
  app.post("/footprints/:id/photos", { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const footprint = await app.prisma.footprint.findUnique({ where: { id } });
    if (!footprint || footprint.userId !== req.userId) {
      return reply.code(404).send({ error: "not_found" });
    }
    // 9 张上限：与撰写器/导入的 9 张口径统一。校验先于 req.file()/storage.put，
    // 超限请求不消费文件流、不留孤儿对象。并发竞态下可能短暂超限，但单客户端
    // 顺序上传无感，读侧 orderIndex+id 兜底排序无害，不为此加库级约束。
    const photoCount = await app.prisma.footprintPhoto.count({
      where: { footprintId: footprint.id },
    });
    if (photoCount >= 9) {
      return reply.code(400).send({ error: "photo_limit_reached" });
    }
    const data = await req.file();
    if (!data) return reply.code(400).send({ error: "file_required" });
    const ext = EXT_BY_MIME[data.mimetype];
    if (!ext) return reply.code(415).send({ error: "unsupported_media_type" });

    // toBuffer() 必须先于 fields 读取——若 fields 排在多部分表单里 file 之后，
    // @fastify/multipart 要消费完文件流才会填好 data.fields。但 meta 校验本身
    // 必须排在 storage.put 之前：先校验后落盘，避免非法 meta 在 MinIO 里留孤儿对象。
    const buffer = await data.toBuffer();

    const takenAt = fieldValue(data.fields, "takenAt");
    const lat = fieldValue(data.fields, "lat");
    const lng = fieldValue(data.fields, "lng");
    const meta = photoMetaSchema.safeParse({
      takenAt: takenAt || undefined,
      lat: lat || undefined,
      lng: lng || undefined,
    });
    if (!meta.success) {
      return reply.code(400).send({ error: "invalid_photo_meta", detail: meta.error.flatten() });
    }

    const key = `photos/${footprint.id}/${randomUUID()}.${ext}`;
    await app.storage.put(key, buffer, data.mimetype);
    // 公开态足迹新增照片 = 内容变更，须回审核队列（镜像 PATCH 改内容分支），
    // 同一事务原子完成，防"审后偷加图"绕过审核直接上公开面。
    const isPublic = footprint.visibility === PUBLICLY_VISIBLE.visibility;
    const photo = await app.prisma.$transaction(async (tx) => {
      // 追加序号：取当前 max orderIndex + 1（空集从 0 起），新照片恒排末尾；
      // 与 create 同事务，避免并发上传读到同一 max 后互相覆盖顺序语义。
      const agg = await tx.footprintPhoto.aggregate({
        where: { footprintId: footprint.id },
        _max: { orderIndex: true },
      });
      const created = await tx.footprintPhoto.create({
        data: {
          footprintId: footprint.id,
          mediaUrl: key,
          orderIndex: (agg._max.orderIndex ?? -1) + 1,
          takenAt: meta.data.takenAt ? new Date(meta.data.takenAt) : null,
          lat: meta.data.lat ?? null,
          lng: meta.data.lng ?? null,
        },
      });
      if (isPublic) {
        await tx.footprint.update({
          where: { id: footprint.id },
          data: { reviewStatus: "PENDING", publicRequestedAt: new Date() },
        });
      }
      return created;
    });
    return reply.code(201).send({ id: photo.id, takenAt: photo.takenAt });
  });

  app.get("/photos/:id", { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const photo = await app.prisma.footprintPhoto.findUnique({
      where: { id },
      include: { footprint: { select: { userId: true, visibility: true, reviewStatus: true } } },
    });
    const isOwner = photo?.footprint.userId === req.userId;
    const isPublic =
      photo?.footprint.visibility === PUBLICLY_VISIBLE.visibility &&
      photo?.footprint.reviewStatus === PUBLICLY_VISIBLE.reviewStatus;
    if (!photo || (!isOwner && !isPublic)) {
      return reply.code(404).send({ error: "not_found" });
    }
    return { url: await app.storage.presignGet(photo.mediaUrl, 300) };
  });

  // 与 GET /photos/:id 的关键差异：读允许公开面（PUBLIC+APPROVED 的照片陌生人可读），
  // 删仅属主可为——photo 不存在或非属主一律 404，不泄露照片是否存在。
  // 全程不触碰 reviewStatus / publicRequestedAt：删图不回审（spec §3 宽松重审策略——
  // 删除只减内容、不引入未审内容，无须重新过审）。
  app.delete("/photos/:id", { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const photo = await app.prisma.footprintPhoto.findUnique({
      where: { id },
      include: { footprint: { select: { userId: true } } },
    });
    if (!photo || photo.footprint.userId !== req.userId) {
      return reply.code(404).send({ error: "not_found" });
    }
    // 先删 DB 后清 S3：S3 失败最多留孤儿对象（可容忍），反之悬空 DB 行不可容忍。
    // await 而非 fire-and-forget：响应返回时清理已发生，测试可直接断言；吞错仅告警。
    await app.prisma.footprintPhoto.delete({ where: { id: photo.id } });
    try {
      await app.storage.remove([photo.mediaUrl]);
    } catch (err) {
      app.log.warn({ err, mediaUrl: photo.mediaUrl }, "照片对象清理失败，留下孤儿对象");
    }
    return reply.code(204).send();
  });

  // 全量排列语义：photoIds 必须与该足迹现存照片集合完全相等，换来的是
  // "校验即防越权+天然幂等"——集合相等保证每个 id 都属于本足迹（不可能借重排
  // 改到别人照片的 orderIndex），且同一排列重放只是把相同值再写一遍，天然幂等。
  // 全程不触碰 reviewStatus / publicRequestedAt：排序不回审（spec §3 宽松重审
  // 策略——集合未变、仅展示序变化，未引入未审内容，无须重新过审）。
  app.put("/footprints/:id/photos/order", { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = reorderSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    }
    // 属主判定镜像上传路由：足迹不存在或非属主一律 404，不泄露足迹是否存在。
    const footprint = await app.prisma.footprint.findUnique({ where: { id } });
    if (!footprint || footprint.userId !== req.userId) {
      return reply.code(404).send({ error: "not_found" });
    }
    const { photoIds } = body.data;
    const existing = await app.prisma.footprintPhoto.findMany({
      where: { footprintId: footprint.id },
      select: { id: true },
    });
    // 集合相等判定：去重后长度 = 原长 = 现存数，且每个现存 id 都在集合中
    // （无重复、无缺失、无多余）。0 张足迹 + 空数组自然通过，204 no-op。
    const idSet = new Set(photoIds);
    const setMatches =
      idSet.size === photoIds.length &&
      photoIds.length === existing.length &&
      existing.every((p) => idSet.has(p.id));
    if (!setMatches) {
      return reply.code(400).send({ error: "invalid_body", detail: "photo_set_mismatch" });
    }
    // 事务内按数组下标批量写 orderIndex，要么全部生效要么全不生效，
    // 不会留下"排到一半"的中间序。集合校验已保证每个 id 都属于该足迹。
    await app.prisma.$transaction(
      photoIds.map((photoId, i) =>
        app.prisma.footprintPhoto.update({ where: { id: photoId }, data: { orderIndex: i } }),
      ),
    );
    return reply.code(204).send();
  });
}
