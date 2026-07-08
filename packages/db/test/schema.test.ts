import { afterAll, beforeEach, expect, test } from "vitest";
import { createPrisma } from "../src/index.js";

const prisma = createPrisma(
  process.env.TEST_DATABASE_URL ?? "postgresql://zhixing:zhixing@localhost:5433/zhixing_test",
);

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Like","CardFavorite","CardReport","FootprintPhoto","Footprint","Trip","CardBlock","Card","Place","User","SearchMiss" RESTART IDENTITY CASCADE',
  );
});
afterAll(async () => prisma.$disconnect());

test("创建地点与多块风物卡并按 order 读回", async () => {
  const place = await prisma.place.create({
    data: { name: "什刹海", level: "DISTRICT", lat: 39.94, lng: 116.38 },
  });
  const card = await prisma.card.create({
    data: {
      placeId: place.id,
      category: "ANECDOTE",
      title: "银锭观山",
      sources: ["《燕都游览志》"],
      blocks: {
        create: [
          { order: 0, type: "TEXT", text: "第一段" },
          { order: 1, type: "TEXT", text: "第二段" },
        ],
      },
    },
  });
  const read = await prisma.card.findUniqueOrThrow({
    where: { id: card.id },
    include: { blocks: { orderBy: { order: "asc" } } },
  });
  expect(read.status).toBe("AI_GENERATED"); // 默认状态即 AI 生成
  expect(read.blocks.map((b) => b.text)).toEqual(["第一段", "第二段"]);
});
