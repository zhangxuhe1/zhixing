import { afterAll, beforeEach, expect, test } from "vitest";
import { resetDb, testApp, userAuth } from "./helpers.js";

const app = testApp();
beforeEach(() => resetDb(app));
afterAll(async () => app.close());

test("提交新地点:PENDING/POI/归属本人,父级自动挂最近城市", async () => {
  const prov = await app.prisma.place.create({
    data: { name: "山东省", level: "PROVINCE", lat: 36.67, lng: 117.02 },
  });
  const jinan = await app.prisma.place.create({
    data: { name: "济南市", level: "CITY", parentId: prov.id, lat: 36.651, lng: 117.12 },
  });
  const { headers, user } = await userAuth(app);

  const res = await app.inject({
    method: "POST", url: "/places", headers,
    payload: { name: "宽厚里", lat: 36.661, lng: 117.03 },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  expect(body.status).toBe("PENDING");
  expect(body.level).toBe("POI");
  expect(body.parentId).toBe(jinan.id); // 12km 内命中济南
  expect(body.cardCount).toBe(0);
  expect(body).not.toHaveProperty("createdById"); // 归属不外传

  const row = await app.prisma.place.findUniqueOrThrow({ where: { id: body.id } });
  expect(row.createdById).toBe(user.id);
});

test("直辖市可作父级(省级链顶且无市级子节点);远海无候选则父级为空", async () => {
  const beijing = await app.prisma.place.create({
    data: { name: "北京市", level: "PROVINCE", lat: 39.9042, lng: 116.4074 },
  });
  await app.prisma.place.create({
    data: { name: "什刹海", level: "DISTRICT", parentId: beijing.id, lat: 39.94, lng: 116.38 },
  });
  const { headers } = await userAuth(app);

  const near = await app.inject({
    method: "POST", url: "/places", headers,
    payload: { name: "杨梅竹斜街", lat: 39.895, lng: 116.392 },
  });
  expect(near.json().parentId).toBe(beijing.id);

  const far = await app.inject({
    method: "POST", url: "/places", headers,
    payload: { name: "南海孤岛", lat: 10.0, lng: 114.0 },
  });
  expect(far.statusCode).toBe(201);
  expect(far.json().parentId).toBeNull();
});

test("普通省(有市级子节点)不做父级候选:落点挂市不挂省", async () => {
  const prov = await app.prisma.place.create({
    data: { name: "山东省", level: "PROVINCE", lat: 36.6683, lng: 117.0201 },
  });
  const jinan = await app.prisma.place.create({
    data: { name: "济南市", level: "CITY", parentId: prov.id, lat: 36.651, lng: 117.12 },
  });
  const { headers } = await userAuth(app);
  const res = await app.inject({
    method: "POST", url: "/places", headers,
    payload: { name: "曲水亭街", lat: 36.668, lng: 117.024 }, // 离省坐标(=济南)与市坐标都近
  });
  expect(res.json().parentId).toBe(jinan.id);
});

test("同名同父冲突 409 并回已有地点 id", async () => {
  const city = await app.prisma.place.create({
    data: { name: "济南市", level: "CITY", lat: 36.651, lng: 117.12 },
  });
  const exist = await app.prisma.place.create({
    data: { name: "芙蓉街", level: "DISTRICT", parentId: city.id, lat: 36.665, lng: 117.023 },
  });
  const { headers } = await userAuth(app);
  const res = await app.inject({
    method: "POST", url: "/places", headers,
    payload: { name: "芙蓉街", lat: 36.665, lng: 117.023 },
  });
  expect(res.statusCode).toBe(409);
  expect(res.json()).toEqual({ error: "place_exists", placeId: exist.id });
});

test("24 小时滚动窗内第 11 个申请 429;开关关闭 403;匿名 401;非法 body 400", async () => {
  const { headers } = await userAuth(app);
  for (let i = 0; i < 10; i++) {
    const res = await app.inject({
      method: "POST", url: "/places", headers,
      payload: { name: `新点${i}`, lat: 30 + i * 0.01, lng: 110 },
    });
    expect(res.statusCode).toBe(201);
  }
  const eleventh = await app.inject({
    method: "POST", url: "/places", headers,
    payload: { name: "第十一个", lat: 31, lng: 110 },
  });
  expect(eleventh.statusCode).toBe(429);
  expect(eleventh.json().error).toBe("daily_limit");

  const offApp = testApp({ placeSubmission: false });
  const { headers: offHeaders } = await userAuth(offApp);
  const off = await offApp.inject({
    method: "POST", url: "/places", headers: offHeaders,
    payload: { name: "关着呢", lat: 30, lng: 110 },
  });
  expect(off.statusCode).toBe(403);
  expect(off.json().error).toBe("place_submission_disabled");
  await offApp.close();

  const anon = await app.inject({
    method: "POST", url: "/places", payload: { name: "匿名", lat: 30, lng: 110 },
  });
  expect(anon.statusCode).toBe(401);

  const bad = await app.inject({
    method: "POST", url: "/places", headers,
    payload: { name: "", lat: 999, lng: 110 },
  });
  expect(bad.statusCode).toBe(400);
  expect(bad.json().error).toBe("invalid_body");
});
