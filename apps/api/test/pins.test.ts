import { afterAll, beforeEach, expect, test } from "vitest";
import { resetDb, testApp } from "./helpers.js";

const app = testApp();
beforeEach(() => resetDb(app));
afterAll(async () => app.close());

async function seed() {
  const a = await app.prisma.place.create({ data: { name: "什刹海", level: "DISTRICT", lat: 39.94, lng: 116.38 } });
  const b = await app.prisma.place.create({ data: { name: "大栅栏", level: "DISTRICT", lat: 39.9, lng: 116.4 } });
  await app.prisma.card.create({
    data: {
      placeId: a.id, category: "ANECDOTE", title: "银锭观山", sources: ["x"],
      blocks: { create: [{ order: 0, type: "TEXT", text: "a".repeat(60) }] },
    },
  });
  const retired = await app.prisma.card.create({
    data: {
      placeId: b.id, category: "FOOD", title: "已下架", sources: ["x"], status: "RETIRED",
      blocks: { create: [{ order: 0, type: "TEXT", text: "b".repeat(60) }] },
    },
  });
  return { a, b, retired };
}

test("pins 带非下架卡数", async () => {
  const { a, b } = await seed();
  const res = await app.inject({ method: "GET", url: "/places/pins" });
  const pins = res.json() as Array<{ id: string; cardCount: number }>;
  expect(pins.find((p) => p.id === a.id)?.cardCount).toBe(1);
  expect(pins.find((p) => p.id === b.id)?.cardCount).toBe(0); // RETIRED 不计
});

test("random 只落在有内容的地点", async () => {
  const { a } = await seed();
  for (let i = 0; i < 5; i++) {
    const res = await app.inject({ method: "GET", url: "/places/random" });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(a.id);
    expect(res.json().cardCount).toBe(1);
  }
});

test("全库无内容时 random 404", async () => {
  const res = await app.inject({ method: "GET", url: "/places/random" });
  expect(res.statusCode).toBe(404);
});

test("random 带祖先链", async () => {
  const prov = await app.prisma.place.create({
    data: { name: "北京市", level: "PROVINCE", lat: 39.9, lng: 116.4 },
  });
  const spot = await app.prisma.place.create({
    data: { name: "什刹海", level: "DISTRICT", parentId: prov.id, lat: 39.94, lng: 116.38 },
  });
  await app.prisma.card.create({
    data: {
      placeId: spot.id, category: "ANECDOTE", title: "银锭观山", sources: ["x"],
      blocks: { create: [{ order: 0, type: "TEXT", text: "a".repeat(60) }] },
    },
  });
  const res = await app.inject({ method: "GET", url: "/places/random" });
  expect(res.json().ancestors).toEqual([{ id: prov.id, name: "北京市", level: "PROVINCE" }]);
});
