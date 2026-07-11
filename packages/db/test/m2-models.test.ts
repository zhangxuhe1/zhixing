import { afterAll, beforeEach, expect, test } from "vitest";
import { createPrisma } from "../src/index.js";

const prisma = createPrisma(
  process.env.TEST_DATABASE_URL ?? "postgresql://zhixing:zhixing@localhost:5433/zhixing_test",
);

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Like","CardFavorite","CardReport","FootprintPhoto","Footprint","Trip","CardBlock","Card","Place","User","Identity","SearchMiss" RESTART IDENTITY CASCADE',
  );
});
afterAll(async () => prisma.$disconnect());

async function createUser() {
  return prisma.user.create({
    data: { nickname: "阿彪" },
  });
}

async function createPlaceAndFootprint(userId: string) {
  const place = await prisma.place.create({
    data: { name: "什刹海", level: "DISTRICT", lat: 39.94, lng: 116.38 },
  });
  const footprint = await prisma.footprint.create({
    data: { userId, placeId: place.id, date: new Date("2026-01-01") },
  });
  return { place, footprint };
}

test("Like 唯一约束：同 (userId, footprintId) 二次 create 抛 P2002", async () => {
  const user = await createUser();
  const { footprint } = await createPlaceAndFootprint(user.id);

  await prisma.like.create({ data: { userId: user.id, footprintId: footprint.id } });

  await expect(
    prisma.like.create({ data: { userId: user.id, footprintId: footprint.id } }),
  ).rejects.toMatchObject({ code: "P2002" });
});

test("Trip 删除 SetNull：delete Trip 后 footprint 仍在且 tripId 为 null", async () => {
  const user = await createUser();
  const { footprint } = await createPlaceAndFootprint(user.id);

  const trip = await prisma.trip.create({
    data: {
      userId: user.id,
      title: "京城漫游",
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-01-05"),
    },
  });
  await prisma.footprint.update({
    where: { id: footprint.id },
    data: { tripId: trip.id },
  });

  await prisma.trip.delete({ where: { id: trip.id } });

  const found = await prisma.footprint.findUniqueOrThrow({ where: { id: footprint.id } });
  expect(found.tripId).toBeNull();
});

test("级联：delete User 后其 Like/CardFavorite/CardReport/Trip 全消失", async () => {
  // 注意：Footprint 归属另一用户创建，避免撞上既有 Footprint.userId 关系（非本任务范围）的删除限制。
  const footprintOwner = await createUser();
  const { place, footprint } = await createPlaceAndFootprint(footprintOwner.id);
  const user = await createUser();
  const card = await prisma.card.create({
    data: {
      placeId: place.id,
      category: "ANECDOTE",
      title: "银锭观山",
      sources: [],
    },
  });

  const like = await prisma.like.create({ data: { userId: user.id, footprintId: footprint.id } });
  const favorite = await prisma.cardFavorite.create({
    data: { userId: user.id, cardId: card.id },
  });
  const report = await prisma.cardReport.create({
    data: { userId: user.id, cardId: card.id, text: "内容有误" },
  });
  const trip = await prisma.trip.create({
    data: {
      userId: user.id,
      title: "京城漫游",
      startDate: new Date("2026-01-01"),
      endDate: new Date("2026-01-05"),
    },
  });

  await prisma.user.delete({ where: { id: user.id } });

  expect(await prisma.like.findUnique({ where: { id: like.id } })).toBeNull();
  expect(await prisma.cardFavorite.findUnique({ where: { id: favorite.id } })).toBeNull();
  expect(await prisma.cardReport.findUnique({ where: { id: report.id } })).toBeNull();
  expect(await prisma.trip.findUnique({ where: { id: trip.id } })).toBeNull();
});
