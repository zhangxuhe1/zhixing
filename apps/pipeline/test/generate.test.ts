import { afterAll, beforeEach, expect, test } from "vitest";
import { createPrisma } from "@zhixing/db";
import { saveDraft } from "../src/generate.js";

const prisma = createPrisma(
  process.env.TEST_DATABASE_URL ?? "postgresql://zhixing:zhixing@localhost:5432/zhixing_test",
);

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "FootprintPhoto","Footprint","CardBlock","Card","Place","User","SearchMiss" RESTART IDENTITY CASCADE',
  );
});
afterAll(async () => prisma.$disconnect());

test("草稿入库为 AI_GENERATED，块序与来源正确", async () => {
  const place = await prisma.place.create({
    data: { name: "什刹海", level: "DISTRICT", lat: 39.94, lng: 116.383 },
  });
  const card = await saveDraft(prisma, place.id, "ANECDOTE", {
    title: "银锭观山",
    blocks: [
      { type: "text", content: "a".repeat(60) },
      { type: "text", content: "b".repeat(60) },
    ],
    sources: ["《燕都游览志》"],
  });
  expect(card.status).toBe("AI_GENERATED");
  expect(card.blocks.map((b) => b.order)).toEqual([0, 1]);
  expect(card.blocks.every((b) => b.type === "TEXT")).toBe(true);
  expect(card.sources).toEqual(["《燕都游览志》"]);
});
