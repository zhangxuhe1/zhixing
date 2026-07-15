import { expect, test } from "vitest";
import { createPrisma } from "@zhixing/db";
import { pickJobs, queryFillTargets } from "../src/batch.js";

const prisma = createPrisma(
  process.env.TEST_DATABASE_URL ?? "postgresql://zhixing:zhixing@localhost:5433/zhixing_test",
);

const pins = [
  { id: "1", name: "什刹海", cardCount: 1 },
  { id: "2", name: "大栅栏", cardCount: 3 },
  { id: "3", name: "芙蓉街", cardCount: 0 },
];

test("补足到 target，分类轮转，已达标地点跳过", () => {
  const jobs = pickJobs(pins, 3, ["ANECDOTE", "FOOD", "CUSTOMS", "PLACE_NAME", "DIALECT"]);
  expect(jobs.filter((j) => j.placeName === "大栅栏")).toHaveLength(0);
  expect(jobs.filter((j) => j.placeName === "什刹海")).toHaveLength(2);
  expect(jobs.filter((j) => j.placeName === "芙蓉街")).toHaveLength(3);
  // 轮转从当前已有张数起步，避免每次都从同一分类开始
  expect(jobs.filter((j) => j.placeName === "芙蓉街").map((j) => j.category)).toEqual([
    "ANECDOTE", "FOOD", "CUSTOMS",
  ]);
  expect(jobs.filter((j) => j.placeName === "什刹海").map((j) => j.category)).toEqual([
    "FOOD", "CUSTOMS",
  ]);
});

test("queryFillTargets 只圈 ACTIVE 地点——待审/驳回点不进补卡计划", async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "FootprintPhoto","Footprint","CardBlock","Card","PlaceLink","Place","User","SearchMiss" RESTART IDENTITY CASCADE',
  );
  await prisma.place.create({ data: { name: "官方点", level: "DISTRICT", lat: 30, lng: 110 } });
  await prisma.place.create({
    data: { name: "待审点", level: "POI", lat: 30, lng: 110, status: "PENDING" },
  });
  const targets = await queryFillTargets(prisma);
  expect(targets.map((t) => t.name)).toEqual(["官方点"]);
  await prisma.$disconnect();
});
