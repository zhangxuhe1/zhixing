import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, expect, test } from "vitest";
import { createPrisma } from "@zhixing/db";
import { importPlaces } from "../src/import-places.js";

const prisma = createPrisma(
  process.env.TEST_DATABASE_URL ?? "postgresql://zhixing:zhixing@localhost:5433/zhixing_test",
);
const dataPath = fileURLToPath(new URL("../data/beijing-places.json", import.meta.url));

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "FootprintPhoto","Footprint","CardBlock","Card","Place","User","SearchMiss" RESTART IDENTITY CASCADE',
  );
});
afterAll(async () => prisma.$disconnect());

test("导入北京地点库，幂等可重复执行", async () => {
  const first = await importPlaces(prisma, dataPath);
  expect(first.spotCount).toBe(15);

  const again = await importPlaces(prisma, dataPath); // 第二次执行不重复建
  expect(again.spotCount).toBe(15);
  expect(await prisma.place.count()).toBe(16); // 1 城市 + 15 街区

  const spot = await prisma.place.findFirstOrThrow({ where: { name: "什刹海" } });
  expect(spot.parentId).toBe(first.city.id);
  expect(spot.level).toBe("DISTRICT");
  expect(first.city.level).toBe("PROVINCE");
});

test("直辖市升级:存量北京市 CITY 链顶,重跑导入后升为 PROVINCE,节点复用", async () => {
  const legacy = await prisma.place.create({
    data: { name: "北京市", level: "CITY", lat: 39.9042, lng: 116.4074 },
  });
  const r = await importPlaces(prisma, dataPath);
  expect(r.city.id).toBe(legacy.id);
  expect(r.city.level).toBe("PROVINCE");
  expect(await prisma.place.count()).toBe(16); // 1 + 15,没有多出节点
});
