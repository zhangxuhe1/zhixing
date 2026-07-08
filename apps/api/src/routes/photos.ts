import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { MultipartFields } from "@fastify/multipart";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { PUBLICLY_VISIBLE } from "../visibility.js";

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
    const data = await req.file();
    if (!data) return reply.code(400).send({ error: "file_required" });
    const ext = EXT_BY_MIME[data.mimetype];
    if (!ext) return reply.code(415).send({ error: "unsupported_media_type" });

    const buffer = await data.toBuffer();
    const key = `photos/${footprint.id}/${randomUUID()}.${ext}`;
    await app.storage.put(key, buffer, data.mimetype);

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
    // 公开态足迹新增照片 = 内容变更，须回审核队列（镜像 PATCH 改内容分支），
    // 同一事务原子完成，防"审后偷加图"绕过审核直接上公开面。
    const isPublic = footprint.visibility === PUBLICLY_VISIBLE.visibility;
    const photo = await app.prisma.$transaction(async (tx) => {
      const created = await tx.footprintPhoto.create({
        data: {
          footprintId: footprint.id,
          mediaUrl: key,
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
}
