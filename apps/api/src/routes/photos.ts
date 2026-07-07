import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { MultipartFields } from "@fastify/multipart";
import { requireUser } from "../auth.js";
import { PUBLICLY_VISIBLE } from "../visibility.js";

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
};

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
    const photo = await app.prisma.footprintPhoto.create({
      data: {
        footprintId: footprint.id,
        mediaUrl: key,
        takenAt: takenAt ? new Date(takenAt) : null,
        lat: lat ? Number(lat) : null,
        lng: lng ? Number(lng) : null,
      },
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
