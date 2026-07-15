import { databaseUrl } from "./env.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPrisma, type PrismaClient } from "@zhixing/db";

type RegionsFile = {
  cities: Array<{
    name: string; lat: number; lng: number; intro?: string;
    /** 直辖市/特区:自身即省级链顶,不挂省 */
    level?: "PROVINCE";
    /** 普通城市所属省(同省城市重复声明同一对象,按名幂等) */
    province?: { name: string; lat: number; lng: number };
    spots: Array<{ name: string; lat: number; lng: number; intro?: string }>;
  }>;
};

export async function importRegions(
  prisma: PrismaClient,
  dataPath: string,
): Promise<{ cityCount: number; spotCount: number }> {
  const seed = JSON.parse(readFileSync(dataPath, "utf-8")) as RegionsFile;
  let spotCount = 0;
  for (const c of seed.cities) {
    // 1) 省节点(可选):链顶 findFirst+create 幂等
    let provinceId: string | null = null;
    if (c.province) {
      let prov = await prisma.place.findFirst({
        where: { name: c.province.name, parentId: null },
      });
      if (!prov) {
        prov = await prisma.place.create({
          data: { name: c.province.name, level: "PROVINCE", lat: c.province.lat, lng: c.province.lng },
        });
      }
      provinceId = prov.id;
    }

    // 2) 城市节点:先按 (name, 目标父) 找;找不到再找存量链顶同名城做"补挂"
    //   (生产老数据把城市建成 parentId=null,重跑导入即完成迁移,不建重复节点)
    const level = c.level ?? "CITY";
    let city = await prisma.place.findFirst({ where: { name: c.name, parentId: provinceId } });
    if (!city && provinceId) {
      const legacy = await prisma.place.findFirst({ where: { name: c.name, parentId: null } });
      if (legacy) {
        city = await prisma.place.update({
          where: { id: legacy.id },
          data: { parentId: provinceId, level },
        });
      }
    }
    if (!city) {
      city = await prisma.place.create({
        data: { name: c.name, level, lat: c.lat, lng: c.lng, intro: c.intro, parentId: provinceId },
      });
    } else if (city.level !== level) {
      city = await prisma.place.update({ where: { id: city.id }, data: { level } });
    }

    for (const s of c.spots) {
      await prisma.place.upsert({
        where: { name_parentId: { name: s.name, parentId: city.id } },
        update: { lat: s.lat, lng: s.lng, intro: s.intro },
        create: { ...s, level: "DISTRICT", parentId: city.id },
      });
      spotCount++;
    }
  }
  return { cityCount: seed.cities.length, spotCount };
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const prisma = createPrisma(databaseUrl);
  const dataPath = fileURLToPath(new URL("../data/regions-places.json", import.meta.url));
  importRegions(prisma, dataPath)
    .then((r) => console.log(`imported: ${r.cityCount} cities + ${r.spotCount} spots`))
    .finally(() => prisma.$disconnect());
}
