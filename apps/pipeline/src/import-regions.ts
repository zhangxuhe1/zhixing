import { databaseUrl } from "./env.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPrisma, type PrismaClient } from "@zhixing/db";

type RegionsFile = {
  cities: Array<{
    name: string; lat: number; lng: number; intro?: string;
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
    let city = await prisma.place.findFirst({ where: { name: c.name, parentId: null } });
    if (!city) {
      city = await prisma.place.create({
        data: { name: c.name, level: "CITY", lat: c.lat, lng: c.lng, intro: c.intro },
      });
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
