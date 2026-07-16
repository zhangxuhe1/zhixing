import { afterAll, beforeEach, expect, test } from "vitest";
import { createPrisma } from "../src/index.js";

const prisma = createPrisma(
  process.env.TEST_DATABASE_URL ?? "postgresql://zhixing:zhixing@localhost:5433/zhixing_test",
);

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Like","CardFavorite","CardReport","FootprintPhoto","Footprint","Trip","CardBlock","Card","PlaceLink","Place","User","Identity","EmailCode","SearchMiss" RESTART IDENTITY CASCADE',
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

test("PlaceLink 往返:挂地点、级联删除", async () => {
  const place = await prisma.place.create({
    data: { name: "什刹海", level: "DISTRICT", lat: 39.94, lng: 116.38 },
  });
  await prisma.placeLink.create({
    data: {
      placeId: place.id, platform: "XIAOHONGSHU",
      title: "什刹海 citywalk 路线", url: "https://example.com/x", sortOrder: 1,
    },
  });
  const links = await prisma.placeLink.findMany({ where: { placeId: place.id } });
  expect(links).toHaveLength(1);
  expect(links[0].platform).toBe("XIAOHONGSHU");

  await prisma.place.delete({ where: { id: place.id } }); // onDelete: Cascade
  expect(await prisma.placeLink.count()).toBe(0);
});
