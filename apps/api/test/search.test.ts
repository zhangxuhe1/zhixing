import { afterAll, beforeEach, expect, test } from "vitest";
import { ADMIN_AUTH, resetDb, testApp } from "./helpers.js";

const app = testApp();
beforeEach(() => resetDb(app));
afterAll(async () => app.close());

test("命中返回地点，不记缺失", async () => {
  await app.prisma.place.create({ data: { name: "什刹海", level: "DISTRICT", lat: 39.94, lng: 116.38 } });
  const res = await app.inject({ method: "GET", url: "/search?q=什刹" });
  expect(res.json().map((p: { name: string }) => p.name)).toEqual(["什刹海"]);
  expect(await app.prisma.searchMiss.count()).toBe(0);
});

test("未命中记缺失且计数累加", async () => {
  for (let i = 0; i < 2; i++) {
    const res = await app.inject({ method: "GET", url: `/search?q=${encodeURIComponent(" 平遥 ")}` });
    expect(res.json()).toEqual([]);
  }
  const miss = await app.prisma.searchMiss.findUniqueOrThrow({ where: { query: "平遥" } });
  expect(miss.count).toBe(2);

  const admin = await app.inject({ method: "GET", url: "/admin/search-misses", headers: ADMIN_AUTH });
  expect(admin.json()[0].query).toBe("平遥");
});

test("空 q 400；admin 未鉴权 401", async () => {
  expect((await app.inject({ method: "GET", url: "/search?q=" })).statusCode).toBe(400);
  expect((await app.inject({ method: "GET", url: "/admin/search-misses" })).statusCode).toBe(401);
});

test("q 超长（trim 后 > 64）400 query_too_long，且不写 SearchMiss", async () => {
  const longQuery = "长".repeat(65);
  const res = await app.inject({ method: "GET", url: `/search?q=${encodeURIComponent(longQuery)}` });
  expect(res.statusCode).toBe(400);
  expect(res.json()).toEqual({ error: "query_too_long" });
  expect(await app.prisma.searchMiss.count()).toBe(0);
});
