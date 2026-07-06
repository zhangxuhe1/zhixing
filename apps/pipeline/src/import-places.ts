import { databaseUrl } from "./env.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPrisma, type Place, type PrismaClient } from "@zhixing/db";

type SeedFile = {
  city: { name: string; level: "CITY"; lat: number; lng: number; intro?: string };
  spots: Array<{ name: string; lat: number; lng: number; intro?: string }>;
};

export async function importPlaces(
  prisma: PrismaClient,
  dataPath: string,
): Promise<{ city: Place; spotCount: number }> {
  const seed = JSON.parse(readFileSync(dataPath, "utf-8")) as SeedFile;

  // 顶层地点 parentId 为 null，复合唯一键对 null 不生效，用 findFirst+create 保证幂等
  let city = await prisma.place.findFirst({ where: { name: seed.city.name, parentId: null } });
  if (!city) {
    city = await prisma.place.create({ data: seed.city });
  }

  for (const s of seed.spots) {
    await prisma.place.upsert({
      where: { name_parentId: { name: s.name, parentId: city.id } },
      update: { lat: s.lat, lng: s.lng, intro: s.intro },
      create: { ...s, level: "DISTRICT", parentId: city.id },
    });
  }
  return { city, spotCount: seed.spots.length };
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const prisma = createPrisma(databaseUrl);
  const dataPath = fileURLToPath(new URL("../data/beijing-places.json", import.meta.url));
  importPlaces(prisma, dataPath)
    .then((r) => console.log(`imported: ${r.city.name} + ${r.spotCount} spots`))
    .finally(() => prisma.$disconnect());
}
