import { afterAll, beforeEach, expect, test } from "vitest";
import { resetDb, testApp, userAuth } from "./helpers.js";

const app = testApp();
beforeEach(() => resetDb(app));
afterAll(async () => app.close());

async function seedPlace(name = "什刹海") {
  return app.prisma.place.create({
    data: { name, level: "DISTRICT", lat: 39.94, lng: 116.38 },
  });
}

async function seedCard(placeId: string, title = "银锭观山") {
  return app.prisma.card.create({
    data: {
      placeId,
      category: "ANECDOTE",
      title,
      sources: [],
      blocks: { create: [{ type: "TEXT", text: "一段卡片内容", order: 0 }] },
    },
  });
}

test("report 创建 201 且库中 status=OPEN", async () => {
  const place = await seedPlace();
  const card = await seedCard(place.id);
  const { headers } = await userAuth(app, "report-user-1");

  const res = await app.inject({
    method: "POST",
    url: `/cards/${card.id}/report`,
    headers,
    payload: { text: "这里的地名有误" },
  });
  expect(res.statusCode).toBe(201);
  expect(res.json().id).toBeTruthy();

  const stored = await app.prisma.cardReport.findUniqueOrThrow({ where: { id: res.json().id } });
  expect(stored.status).toBe("OPEN");
  expect(stored.text).toBe("这里的地名有误");
  expect(stored.cardId).toBe(card.id);
});

test("text 空或超 500 字 → 400 invalid_body", async () => {
  const place = await seedPlace();
  const card = await seedCard(place.id);
  const { headers } = await userAuth(app, "report-user-2");

  const emptyRes = await app.inject({
    method: "POST",
    url: `/cards/${card.id}/report`,
    headers,
    payload: { text: "" },
  });
  expect(emptyRes.statusCode).toBe(400);
  expect(emptyRes.json().error).toBe("invalid_body");

  const tooLongRes = await app.inject({
    method: "POST",
    url: `/cards/${card.id}/report`,
    headers,
    payload: { text: "a".repeat(501) },
  });
  expect(tooLongRes.statusCode).toBe(400);
  expect(tooLongRes.json().error).toBe("invalid_body");

  // 边界：500 字合法
  const boundaryRes = await app.inject({
    method: "POST",
    url: `/cards/${card.id}/report`,
    headers,
    payload: { text: "a".repeat(500) },
  });
  expect(boundaryRes.statusCode).toBe(201);
});

test("未知卡 → 404", async () => {
  const { headers } = await userAuth(app, "report-user-3");
  const res = await app.inject({
    method: "POST",
    url: "/cards/nope/report",
    headers,
    payload: { text: "有问题" },
  });
  expect(res.statusCode).toBe(404);
});

test("未登录访问 → 401", async () => {
  const place = await seedPlace();
  const card = await seedCard(place.id);
  const res = await app.inject({
    method: "POST",
    url: `/cards/${card.id}/report`,
    payload: { text: "有问题" },
  });
  expect(res.statusCode).toBe(401);
});
