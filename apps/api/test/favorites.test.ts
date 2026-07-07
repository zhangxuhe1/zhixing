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

test("收藏幂等：PUT×2 → 列表 1 条；取消后列表空", async () => {
  const place = await seedPlace();
  const card = await seedCard(place.id);
  const { headers } = await userAuth(app, "fav-user-1");

  const put1 = await app.inject({ method: "PUT", url: `/cards/${card.id}/favorite`, headers });
  expect(put1.statusCode).toBe(204);
  const put2 = await app.inject({ method: "PUT", url: `/cards/${card.id}/favorite`, headers });
  expect(put2.statusCode).toBe(204);

  const list = await app.inject({ method: "GET", url: "/me/favorites", headers });
  expect(list.statusCode).toBe(200);
  expect(list.json().items).toHaveLength(1);
  expect(await app.prisma.cardFavorite.count({ where: { cardId: card.id } })).toBe(1);

  const del = await app.inject({ method: "DELETE", url: `/cards/${card.id}/favorite`, headers });
  expect(del.statusCode).toBe(204);

  const listAfter = await app.inject({ method: "GET", url: "/me/favorites", headers });
  expect(listAfter.json().items).toHaveLength(0);

  // 幂等：再次 DELETE 仍 204
  const delAgain = await app.inject({ method: "DELETE", url: `/cards/${card.id}/favorite`, headers });
  expect(delAgain.statusCode).toBe(204);
});

test("列表形状与排序：两张卡不同收藏时间，按 favoritedAt 倒序", async () => {
  const place = await seedPlace();
  const cardA = await seedCard(place.id, "卡片A");
  const cardB = await seedCard(place.id, "卡片B");
  const { headers } = await userAuth(app, "fav-user-2");

  const putA = await app.inject({ method: "PUT", url: `/cards/${cardA.id}/favorite`, headers });
  expect(putA.statusCode).toBe(204);
  await new Promise((r) => setTimeout(r, 10));
  const putB = await app.inject({ method: "PUT", url: `/cards/${cardB.id}/favorite`, headers });
  expect(putB.statusCode).toBe(204);

  const list = await app.inject({ method: "GET", url: "/me/favorites", headers });
  const items = list.json().items;
  expect(items).toHaveLength(2);
  // 倒序：最近收藏（cardB）在前
  expect(items[0].cardId).toBe(cardB.id);
  expect(items[1].cardId).toBe(cardA.id);

  const first = items[0];
  expect(first).toMatchObject({
    cardId: cardB.id,
    title: "卡片B",
    category: "ANECDOTE",
    placeId: place.id,
    placeName: "什刹海",
  });
  expect(typeof first.favoritedAt).toBe("string");
});

test("未知卡 PUT/DELETE → 404", async () => {
  const { headers } = await userAuth(app, "fav-user-3");
  const putRes = await app.inject({ method: "PUT", url: "/cards/nope/favorite", headers });
  expect(putRes.statusCode).toBe(404);
  const delRes = await app.inject({ method: "DELETE", url: "/cards/nope/favorite", headers });
  expect(delRes.statusCode).toBe(404);
});

test("未登录访问 → 401", async () => {
  const place = await seedPlace();
  const card = await seedCard(place.id);
  const putRes = await app.inject({ method: "PUT", url: `/cards/${card.id}/favorite` });
  expect(putRes.statusCode).toBe(401);
  const delRes = await app.inject({ method: "DELETE", url: `/cards/${card.id}/favorite` });
  expect(delRes.statusCode).toBe(401);
  const listRes = await app.inject({ method: "GET", url: "/me/favorites" });
  expect(listRes.statusCode).toBe(401);
});
