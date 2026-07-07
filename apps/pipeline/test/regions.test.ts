import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, expect, test } from "vitest";
import { createPrisma } from "@zhixing/db";
import { importRegions } from "../src/import-regions.js";

const prisma = createPrisma(
  process.env.TEST_DATABASE_URL ?? "postgresql://zhixing:zhixing@localhost:5433/zhixing_test",
);
const dataPath = fileURLToPath(new URL("../data/regions-places.json", import.meta.url));

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "FootprintPhoto","Footprint","CardBlock","Card","Place","User","SearchMiss" RESTART IDENTITY CASCADE',
  );
});
afterAll(async () => prisma.$disconnect());

test("导入多地区，幂等", async () => {
  const first = await importRegions(prisma, dataPath);
  expect(first.cityCount).toBe(16);
  expect(first.spotCount).toBe(12);

  await importRegions(prisma, dataPath);
  expect(await prisma.place.count()).toBe(28); // 16 城 + 12 街区

  const spot = await prisma.place.findFirstOrThrow({ where: { name: "芙蓉街" } });
  const jinan = await prisma.place.findFirstOrThrow({ where: { name: "济南市" } });
  expect(spot.parentId).toBe(jinan.id);
});
