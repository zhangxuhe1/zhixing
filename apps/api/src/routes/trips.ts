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

    const footprints = await app.prisma.footprint.findMany({
      where: { id: { in: body.data.footprintIds } },
      select: { id: true, userId: true, tripId: true, date: true },
    });
    const valid =
      footprints.length === body.data.footprintIds.length &&
      footprints.every((fp) => fp.userId === req.userId && fp.tripId === null);
    if (!valid) return reply.code(400).send({ error: "invalid_footprints" });

    const startDate = new Date(Math.min(...footprints.map((fp) => fp.date.getTime())));
    const endDate = new Date(Math.max(...footprints.map((fp) => fp.date.getTime())));

    const trip = await app.prisma.trip.create({
      data: {
        userId: req.userId,
        title: body.data.title,
        startDate,
        endDate,
        footprints: { connect: body.data.footprintIds.map((id) => ({ id })) },
      },
      include: { footprints: { select: { id: true } } },
    });

    return reply.code(201).send(tripDTO(trip));
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

    if (addIds.length > 0) {
      const toAdd = await app.prisma.footprint.findMany({
        where: { id: { in: addIds } },
        select: { id: true, userId: true, tripId: true },
      });
      const valid =
        toAdd.length === addIds.length &&
        toAdd.every((fp) => fp.userId === req.userId && fp.tripId === null);
      if (!valid) return reply.code(400).send({ error: "invalid_footprints" });
    }

    const currentIds = new Set(existing.footprints.map((fp) => fp.id));
    for (const rid of removeIds) currentIds.delete(rid);
    for (const aid of addIds) currentIds.add(aid);

    if (currentIds.size === 0) {
      return reply.code(400).send({ error: "would_be_empty" });
    }

    const memberDates = await app.prisma.footprint.findMany({
      where: { id: { in: [...currentIds] } },
      select: { date: true },
    });
    const startDate = new Date(Math.min(...memberDates.map((fp) => fp.date.getTime())));
    const endDate = new Date(Math.max(...memberDates.map((fp) => fp.date.getTime())));

    const trip = await app.prisma.trip.update({
      where: { id },
      data: {
        title: body.data.title,
        startDate,
        endDate,
        footprints: {
          disconnect: removeIds.map((rid) => ({ id: rid })),
          connect: addIds.map((aid) => ({ id: aid })),
        },
      },
      include: { footprints: { select: { id: true } } },
    });

    return reply.code(200).send(tripDTO(trip));
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
