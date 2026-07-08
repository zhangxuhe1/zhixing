import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUser } from "../auth.js";
import { segmentTrips, type SegmentInput } from "../trips/segment.js";

const postSchema = z.object({
  title: z.string().min(1).max(60),
  footprintIds: z.array(z.string()).min(1),
});

const patchSchema = z.object({
  title: z.string().min(1).max(60).optional(),
  addFootprintIds: z.array(z.string()).optional(),
  removeFootprintIds: z.array(z.string()).optional(),
});

/** 事务内认领足迹失败的哨兵错误：捕获后回滚并返回 400 invalid_footprints。 */
class InvalidFootprintsError extends Error {}

type PlaceNode = { id: string; parentId: string | null; level: string; name: string };

/** 沿 place.parentId 链找 CITY 级祖先；无则回退自身 id/name。 */
function resolveCity(placeId: string, byId: Map<string, PlaceNode>): { cityKey: string; cityLabel: string } {
  const self = byId.get(placeId);
  let cur = self;
  while (cur) {
    if (cur.level === "CITY") return { cityKey: cur.id, cityLabel: cur.name };
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return { cityKey: self?.id ?? placeId, cityLabel: self?.name ?? placeId };
}

function tripDTO(trip: { id: string; title: string; startDate: Date; endDate: Date; footprints: unknown[] }) {
  return {
    id: trip.id,
    title: trip.title,
    startDate: trip.startDate.toISOString(),
    endDate: trip.endDate.toISOString(),
    footprintCount: trip.footprints.length,
  };
}

export async function tripsRoutes(app: FastifyInstance) {
  app.get("/me/trip-suggestions", { preHandler: requireUser }, async (req) => {
    const [footprints, places] = await Promise.all([
      app.prisma.footprint.findMany({
        where: { userId: req.userId, tripId: null },
        select: { id: true, placeId: true, date: true },
      }),
      app.prisma.place.findMany({ select: { id: true, parentId: true, level: true, name: true } }),
    ]);
    const byId = new Map(places.map((p) => [p.id, p]));

    const inputs: SegmentInput[] = footprints.map((fp) => {
      const { cityKey, cityLabel } = resolveCity(fp.placeId, byId);
      return { footprintId: fp.id, date: fp.date, cityKey, cityLabel };
    });

    const suggestions = segmentTrips(inputs).map((s) => ({
      footprintIds: s.footprintIds,
      suggestedTitle: s.suggestedTitle,
      startDate: s.startDate.toISOString(),
      endDate: s.endDate.toISOString(),
    }));

    return { suggestions };
  });

  app.post("/me/trips", { preHandler: requireUser }, async (req, reply) => {
    const body = postSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });

    // I2：事务内"认领"——先建空壳 Trip，再用 updateMany 原子占有满足
    // (属主本人 且 未归属) 的足迹；认领数 != 目标数 即抛错回滚 → 400。
    // 消除 read-validate-then-connect 竞态（并发/重复占用不会重复归属）。
    const ids = body.data.footprintIds;
    try {
      const trip = await app.prisma.$transaction(async (tx) => {
        const shell = await tx.trip.create({
          data: {
            userId: req.userId,
            title: body.data.title,
            // 占位；认领后用真实成员日期回填。
            startDate: new Date(0),
            endDate: new Date(0),
          },
        });
        const claimed = await tx.footprint.updateMany({
          where: { id: { in: ids }, userId: req.userId, tripId: null },
          data: { tripId: shell.id },
        });
        if (claimed.count !== ids.length) {
          throw new InvalidFootprintsError();
        }
        const members = await tx.footprint.findMany({
          where: { tripId: shell.id },
          select: { date: true },
        });
        const times = members.map((m) => m.date.getTime());
        return tx.trip.update({
          where: { id: shell.id },
          data: { startDate: new Date(Math.min(...times)), endDate: new Date(Math.max(...times)) },
          include: { footprints: { select: { id: true } } },
        });
      });
      return reply.code(201).send(tripDTO(trip));
    } catch (err) {
      if (err instanceof InvalidFootprintsError) {
        return reply.code(400).send({ error: "invalid_footprints" });
      }
      throw err;
    }
  });

  app.get("/me/trips", { preHandler: requireUser }, async (req) => {
    const trips = await app.prisma.trip.findMany({
      where: { userId: req.userId },
      orderBy: { startDate: "desc" },
      include: { footprints: { select: { id: true } } },
    });
    return { items: trips.map(tripDTO) };
  });

  app.patch("/me/trips/:id", { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = patchSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });

    const existing = await app.prisma.trip.findUnique({
      where: { id },
      include: { footprints: { select: { id: true } } },
    });
    if (!existing || existing.userId !== req.userId) {
      return reply.code(404).send({ error: "not_found" });
    }

    const addIds = body.data.addFootprintIds ?? [];
    const removeIds = body.data.removeFootprintIds ?? [];

    // 预判空态：现有成员 - 移除 + 新增（去重）。空则直接 400，不进事务。
    const projected = new Set(existing.footprints.map((fp) => fp.id));
    for (const rid of removeIds) projected.delete(rid);
    for (const aid of addIds) projected.add(aid);
    if (projected.size === 0) {
      return reply.code(400).send({ error: "would_be_empty" });
    }

    try {
      // I2：add 路径同样用事务内 updateMany 认领，消除 validate-then-connect 竞态。
      const trip = await app.prisma.$transaction(async (tx) => {
        if (removeIds.length > 0) {
          // 只解绑本旅程下的成员，避免误动他人/他程足迹。
          await tx.footprint.updateMany({
            where: { id: { in: removeIds }, tripId: id },
            data: { tripId: null },
          });
        }
        if (addIds.length > 0) {
          const claimed = await tx.footprint.updateMany({
            where: { id: { in: addIds }, userId: req.userId, tripId: null },
            data: { tripId: id },
          });
          if (claimed.count !== addIds.length) {
            throw new InvalidFootprintsError();
          }
        }
        const members = await tx.footprint.findMany({
          where: { tripId: id },
          select: { date: true },
        });
        const times = members.map((m) => m.date.getTime());
        return tx.trip.update({
          where: { id },
          data: {
            title: body.data.title,
            startDate: new Date(Math.min(...times)),
            endDate: new Date(Math.max(...times)),
          },
          include: { footprints: { select: { id: true } } },
        });
      });
      return reply.code(200).send(tripDTO(trip));
    } catch (err) {
      if (err instanceof InvalidFootprintsError) {
        return reply.code(400).send({ error: "invalid_footprints" });
      }
      throw err;
    }
  });

  app.delete("/me/trips/:id", { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await app.prisma.trip.findUnique({ where: { id } });
    if (!existing || existing.userId !== req.userId) {
      return reply.code(404).send({ error: "not_found" });
    }
    await app.prisma.trip.delete({ where: { id } });
    return reply.code(204).send();
  });
}
