import { afterAll, beforeEach, expect, test } from "vitest";
import { ADMIN_AUTH, resetDb, testApp, userAuth } from "./helpers.js";

const app = testApp();
beforeEach(() => resetDb(app));
afterAll(async () => app.close());

async function submit(name: string, lat = 36.66, lng = 117.03) {
  const { headers, user } = await userAuth(app, "submitter");
  const res = await app.inject({
    method: "POST",
    url: "/places",
    headers,
    payload: { name, lat, lng },
  });
  expect(res.statusCode).toBe(201);
  return { placeId: res.json().id as string, headers, userId: user.id as string };
}

test("pending 队列:带申请人昵称与猜中的父级名;需要 admin", async () => {
  const city = await app.prisma.place.create({
    data: { name: "济南市", level: "CITY", lat: 36.651, lng: 117.12 },
  });
  const { placeId } = await submit("洪家楼");

  expect(
    (await app.inject({ method: "GET", url: "/admin/places/pending" })).statusCode,
  ).toBe(401);

  const res = await app.inject({
    method: "GET",
    url: "/admin/places/pending",
    headers: ADMIN_AUTH,
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().total).toBe(1);
  const item = res.json().items[0];
  expect(item.id).toBe(placeId);
  expect(item.parentId).toBe(city.id);
  expect(item.parentName).toBe("济南市");
  expect(typeof item.creatorNickname).toBe("string");
});

test("approve:可顺手改名/改父级 → ACTIVE;重复裁决 409", async () => {
  const prov = await app.prisma.place.create({
    data: { name: "山东省", level: "PROVINCE", lat: 36.67, lng: 117.02 },
  });
  const city = await app.prisma.place.create({
    data: { name: "济南市", level: "CITY", parentId: prov.id, lat: 36.651, lng: 117.12 },
  });
  const { placeId } = await submit("洪楼", 36.68, 117.06);

  const ok = await app.inject({
    method: "POST",
    url: `/admin/places/${placeId}/decision`,
    headers: ADMIN_AUTH,
    payload: { action: "approve", name: "洪家楼广场", parentId: city.id },
  });
  expect(ok.statusCode).toBe(204);

  const row = await app.prisma.place.findUniqueOrThrow({ where: { id: placeId } });
  expect(row.status).toBe("ACTIVE");
  expect(row.name).toBe("洪家楼广场");
  expect(row.parentId).toBe(city.id);

  const again = await app.inject({
    method: "POST",
    url: `/admin/places/${placeId}/decision`,
    headers: ADMIN_AUTH,
    payload: { action: "reject" },
  });
  expect(again.statusCode).toBe(409);

  const badParent = await submit("另一个点", 30, 110);
  const bad = await app.inject({
    method: "POST",
    url: `/admin/places/${badParent.placeId}/decision`,
    headers: ADMIN_AUTH,
    payload: { action: "approve", parentId: "nope" },
  });
  expect(bad.statusCode).toBe(400);
  expect(bad.json().error).toBe("unknown_parent");
});

test("reject:REJECTED 后其上私密足迹保留", async () => {
  const { placeId, headers } = await submit("老商埠");
  await app.inject({
    method: "POST",
    url: "/footprints",
    headers,
    payload: { placeId, date: "2026-07-01T10:00:00.000+08:00" },
  });
  const res = await app.inject({
    method: "POST",
    url: `/admin/places/${placeId}/decision`,
    headers: ADMIN_AUTH,
    payload: { action: "reject" },
  });
  expect(res.statusCode).toBe(204);
  expect((await app.prisma.place.findUniqueOrThrow({ where: { id: placeId } })).status).toBe(
    "REJECTED",
  );
  expect(await app.prisma.footprint.count({ where: { placeId } })).toBe(1);
});

test("merge:足迹整体迁移到目标点,源点删除,统计随之归正", async () => {
  const city = await app.prisma.place.create({
    data: { name: "济南市", level: "CITY", lat: 36.651, lng: 117.12 },
  });
  const target = await app.prisma.place.create({
    data: { name: "芙蓉街", level: "DISTRICT", parentId: city.id, lat: 36.665, lng: 117.023 },
  });
  const { placeId, headers } = await submit("芙蓉街小吃街", 36.665, 117.024);
  await app.inject({
    method: "POST",
    url: "/footprints",
    headers,
    payload: { placeId, date: "2026-07-01T10:00:00.000+08:00" },
  });

  const wrongTarget = await app.inject({
    method: "POST",
    url: `/admin/places/${placeId}/merge`,
    headers: ADMIN_AUTH,
    payload: { targetId: placeId },
  });
  expect(wrongTarget.statusCode).toBe(400);

  const res = await app.inject({
    method: "POST",
    url: `/admin/places/${placeId}/merge`,
    headers: ADMIN_AUTH,
    payload: { targetId: target.id },
  });
  expect(res.statusCode).toBe(204);

  expect(await app.prisma.place.findUnique({ where: { id: placeId } })).toBeNull();
  expect(await app.prisma.footprint.count({ where: { placeId: target.id } })).toBe(1);

  // 迁移后统计:1 足迹 / 1 地点 / 1 城市(芙蓉街 → 济南市)
  const stats = await app.inject({ method: "GET", url: "/me/stats", headers });
  expect(stats.json()).toMatchObject({ footprints: 1, places: 1, cities: 1 });
});
