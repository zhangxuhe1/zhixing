import { afterAll, beforeEach, expect, test } from "vitest";
import { ADMIN_AUTH, resetDb, testApp } from "./helpers.js";

const app = testApp();
beforeEach(() => resetDb(app));
afterAll(async () => app.close());

async function makePlace() {
  return app.prisma.place.create({
    data: { name: "什刹海", level: "DISTRICT", lat: 39.94, lng: 116.383 },
  });
}

const cardPayload = (placeId: string) => ({
  placeId,
  category: "ANECDOTE",
  title: "银锭观山",
  sources: ["《燕都游览志》"],
  blocks: [
    { type: "TEXT", text: "站在银锭桥上向西望，是老燕京八景之外的第九景。" },
    { type: "TEXT", text: "相传桥形似倒扣的银锭，故得名。" },
  ],
});

test("创建卡并公开读取（默认 AI_GENERATED）", async () => {
  const place = await makePlace();
  const created = await app.inject({
    method: "POST",
    url: "/admin/cards",
    headers: ADMIN_AUTH,
    payload: cardPayload(place.id),
  });
  expect(created.statusCode).toBe(201);
  expect(created.json().status).toBe("AI_GENERATED");

  const list = await app.inject({ method: "GET", url: `/places/${place.id}/cards` });
  expect(list.json()).toHaveLength(1);
  expect(list.json()[0].blocks.map((b: { text: string }) => b.text)).toEqual(
    cardPayload(place.id).blocks.map((b) => b.text),
  );

  const detail = await app.inject({ method: "GET", url: `/cards/${created.json().id}` });
  expect(detail.json().place.name).toBe("什刹海");
  expect(detail.json().place.ancestors).toEqual([]); // makePlace 造的是链顶点
  expect(detail.json().place).not.toHaveProperty("createdAt"); // place 改为逐字段 DTO
});

test("状态机：review 只能从 AI_GENERATED；retire 不可重复", async () => {
  const place = await makePlace();
  const created = await app.inject({
    method: "POST", url: "/admin/cards", headers: ADMIN_AUTH, payload: cardPayload(place.id),
  });
  const id = created.json().id as string;

  const review = await app.inject({
    method: "POST", url: `/admin/cards/${id}/status`, headers: ADMIN_AUTH,
    payload: { action: "review" },
  });
  expect(review.statusCode).toBe(200);
  expect(review.json().status).toBe("REVIEWED");

  const reviewAgain = await app.inject({
    method: "POST", url: `/admin/cards/${id}/status`, headers: ADMIN_AUTH,
    payload: { action: "review" },
  });
  expect(reviewAgain.statusCode).toBe(409);

  const retire = await app.inject({
    method: "POST", url: `/admin/cards/${id}/status`, headers: ADMIN_AUTH,
    payload: { action: "retire" },
  });
  expect(retire.json().status).toBe("RETIRED");

  const retireAgain = await app.inject({
    method: "POST", url: `/admin/cards/${id}/status`, headers: ADMIN_AUTH,
    payload: { action: "retire" },
  });
  expect(retireAgain.statusCode).toBe(409);

  const list = await app.inject({ method: "GET", url: `/places/${place.id}/cards` });
  expect(list.json()).toHaveLength(0); // RETIRED 不出现在公开列表
});

test("PATCH 替换 blocks 与更新标题", async () => {
  const place = await makePlace();
  const created = await app.inject({
    method: "POST", url: "/admin/cards", headers: ADMIN_AUTH, payload: cardPayload(place.id),
  });
  const id = created.json().id as string;

  const patched = await app.inject({
    method: "PATCH", url: `/admin/cards/${id}`, headers: ADMIN_AUTH,
    payload: { title: "银锭观山（改）", blocks: [{ type: "TEXT", text: "只剩一段" }] },
  });
  expect(patched.statusCode).toBe(200);
  expect(patched.json().title).toBe("银锭观山（改）");
  expect(patched.json().blocks).toHaveLength(1);
});

test("管理接口未鉴权 401", async () => {
  const res = await app.inject({ method: "POST", url: "/admin/cards", payload: {} });
  expect(res.statusCode).toBe(401);
});
