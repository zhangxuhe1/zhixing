import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { PUBLICLY_VISIBLE } from "../visibility.js";
import { cstParts } from "../time.js";

const storiesQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const footprintSelect = {
  id: true,
  text: true,
  date: true,
  likeCount: true,
  viewCount: true,
  user: { select: { nickname: true } },
  photos: { select: { id: true } },
} as const;

type FootprintForDto = {
  id: string;
  text: string | null;
  date: Date;
  likeCount: number;
  viewCount: number;
  user: { nickname: string };
  photos: { id: string }[];
};

function toStoryDto(fp: FootprintForDto, likedFootprintIds: Set<string>) {
  return {
    footprintId: fp.id,
    text: fp.text,
    date: fp.date.toISOString(),
    authorNickname: fp.user.nickname,
    likeCount: fp.likeCount,
    viewCount: fp.viewCount,
    likedByMe: likedFootprintIds.has(fp.id),
    photos: fp.photos.map((p) => ({ photoId: p.id })),
  };
}

async function likedFootprintIdsFor(app: FastifyInstance, userId: string, footprintIds: string[]) {
  if (footprintIds.length === 0) return new Set<string>();
  const likes = await app.prisma.like.findMany({
    where: { userId, footprintId: { in: footprintIds } },
    select: { footprintId: true },
  });
  return new Set(likes.map((l) => l.footprintId));
}

/** 3-5 春 / 6-8 夏 / 9-11 秋 / 12-2 冬；年取足迹日期年份（12 月不跨年归下一年冬）。按 CST 日历分桶。 */
function seasonLabel(date: Date): { year: number; seasonRank: number; label: string } {
  const { y: year, m: month } = cstParts(date);
  if (month >= 3 && month <= 5) return { year, seasonRank: 0, label: `${year}·春` };
  if (month >= 6 && month <= 8) return { year, seasonRank: 1, label: `${year}·夏` };
  if (month >= 9 && month <= 11) return { year, seasonRank: 2, label: `${year}·秋` };
  return { year, seasonRank: 3, label: `${year}·冬` };
}

export async function publicRoutes(app: FastifyInstance) {
  app.get("/places/:id/stories", { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = storiesQuerySchema.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query", detail: q.error.flatten() });

    const place = await app.prisma.place.findUnique({ where: { id } });
    if (!place) return reply.code(404).send({ error: "not_found" });

    const limit = q.data.limit ?? 20;
    let cursorFootprint: { date: Date; id: string } | null = null;
    if (q.data.cursor) {
      // 游标须是本地点下的可见足迹，否则会沦为存在性/日期探测 oracle（可探任意 id，含撤回私密）。
      // 不匹配则当作无游标（回首页），对外无法区分"错游标"与"首页"。
      cursorFootprint = await app.prisma.footprint.findFirst({
        where: { id: q.data.cursor, placeId: id, ...PUBLICLY_VISIBLE },
        select: { date: true, id: true },
      });
    }

    const rows = await app.prisma.footprint.findMany({
      where: {
        placeId: id,
        ...PUBLICLY_VISIBLE,
        ...(cursorFootprint
          ? {
              OR: [
                { date: { lt: cursorFootprint.date } },
                { date: cursorFootprint.date, id: { lt: cursorFootprint.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ date: "desc" }, { id: "desc" }],
      take: limit + 1,
      select: footprintSelect,
    });

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const likedIds = await likedFootprintIdsFor(app, req.userId, page.map((f) => f.id));

    return {
      items: page.map((fp) => toStoryDto(fp, likedIds)),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  });

  app.get("/places/:id/photo-wall", { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const place = await app.prisma.place.findUnique({ where: { id } });
    if (!place) return reply.code(404).send({ error: "not_found" });

    const rows = await app.prisma.footprint.findMany({
      // M1：只取有照片的足迹，避免纯文字足迹产出空分组 { label, photos: [] }。
      where: { placeId: id, ...PUBLICLY_VISIBLE, photos: { some: {} } },
      orderBy: [{ date: "desc" }, { id: "desc" }],
      select: {
        id: true,
        date: true,
        photos: { select: { id: true }, orderBy: { id: "desc" } },
      },
    });

    const groups = new Map<
      string,
      { year: number; seasonRank: number; label: string; photos: { photoId: string; footprintId: string }[] }
    >();
    for (const fp of rows) {
      const { year, seasonRank, label } = seasonLabel(fp.date);
      const key = `${year}-${seasonRank}`;
      let group = groups.get(key);
      if (!group) {
        group = { year, seasonRank, label, photos: [] };
        groups.set(key, group);
      }
      for (const photo of fp.photos) {
        group.photos.push({ photoId: photo.id, footprintId: fp.id });
      }
    }

    const ordered = [...groups.values()]
      .sort((a, b) => b.year - a.year || b.seasonRank - a.seasonRank)
      .map((g) => ({ label: g.label, photos: g.photos }));

    return { groups: ordered };
  });

  app.get("/stories/:footprintId", { preHandler: requireUser }, async (req, reply) => {
    const { footprintId } = req.params as { footprintId: string };
    // 可见性判据走单一来源 PUBLICLY_VISIBLE，不再手写 visibility/reviewStatus 条件。
    const fp = await app.prisma.footprint.findFirst({
      where: { id: footprintId, ...PUBLICLY_VISIBLE },
      select: footprintSelect,
    });
    if (!fp) {
      return reply.code(404).send({ error: "not_found" });
    }
    const likedIds = await likedFootprintIdsFor(app, req.userId, [fp.id]);
    return toStoryDto(fp, likedIds);
  });
}
