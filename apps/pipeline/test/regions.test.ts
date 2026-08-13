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
    'TRUNCATE TABLE "FootprintPhoto","Footprint","CardBlock","Card","PlaceLink","PlaceLinkTag","Place","User","SearchMiss" RESTART IDENTITY CASCADE',
  );
});
afterAll(async () => prisma.$disconnect());

test("导入多地区:建省挂城、直辖市/特区为省级链顶、幂等", async () => {
  const first = await importRegions(prisma, dataPath);
  expect(first.cityCount).toBe(16);
  expect(first.spotCount).toBe(12);

  await importRegions(prisma, dataPath);
  // 12 省 + 16 城 + 12 街区(香港/澳门是省级链顶,不再另建省)
  expect(await prisma.place.count()).toBe(40);

  const shandong = await prisma.place.findFirstOrThrow({ where: { name: "山东省" } });
  expect(shandong.level).toBe("PROVINCE");
  expect(shandong.parentId).toBeNull();

  const jinan = await prisma.place.findFirstOrThrow({ where: { name: "济南市" } });
  expect(jinan.parentId).toBe(shandong.id);

  const spot = await prisma.place.findFirstOrThrow({ where: { name: "芙蓉街" } });
  expect(spot.parentId).toBe(jinan.id);

  const hk = await prisma.place.findFirstOrThrow({ where: { name: "香港" } });
  expect(hk.level).toBe("PROVINCE");
  expect(hk.parentId).toBeNull();
});

test("存量补挂:老库里链顶城市(parentId=null)重跑导入后挂到省下,不产生重复城市", async () => {
  // 模拟生产存量:济南市已作为链顶 CITY 存在,且下面已有街区
  const legacy = await prisma.place.create({
    data: { name: "济南市", level: "CITY", lat: 36.651, lng: 117.12 },
  });
  await prisma.place.create({
    data: { name: "芙蓉街", level: "DISTRICT", parentId: legacy.id, lat: 36.665, lng: 117.023 },
  });

  await importRegions(prisma, dataPath);

  const jinans = await prisma.place.findMany({ where: { name: "济南市" } });
  expect(jinans).toHaveLength(1); // 不重复建
  expect(jinans[0].id).toBe(legacy.id); // 就是原节点(足迹/卡不受牵连)
  const shandong = await prisma.place.findFirstOrThrow({ where: { name: "山东省" } });
  expect(jinans[0].parentId).toBe(shandong.id); // 补挂成功
});
