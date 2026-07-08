import type { FastifyInstance } from "fastify";

/**
 * 批量聚合一批地点下"未下架"（非 RETIRED）卡片数。
 * places.ts（/places/pins、/places/random）与 search.ts（/search）共用同一计数语义，
 * 避免两处各自手写 card.groupBy 而未来跑偏（如一处漏过滤 RETIRED）。
 */
export async function countCardsByPlace(
  prisma: FastifyInstance["prisma"],
  placeIds: string[],
): Promise<Map<string, number>> {
  if (placeIds.length === 0) return new Map();
  const counts = await prisma.card.groupBy({
    by: ["placeId"],
    where: { placeId: { in: placeIds }, status: { not: "RETIRED" } },
    _count: { _all: true },
  });
  return new Map(counts.map((c) => [c.placeId, c._count._all]));
}
