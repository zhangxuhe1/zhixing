import { afterAll, beforeEach, expect, test } from "vitest";
import { ADMIN_AUTH, resetDb, testApp } from "./helpers.js";

const app = testApp();
beforeEach(() => resetDb(app));
afterAll(async () => app.close());

async function makeTag(name: string, sortOrder?: number) {
  const res = await app.inject({
    method: "POST", url: "/admin/link-tags", headers: ADMIN_AUTH,
    payload: { name, ...(sortOrder !== undefined ? { sortOrder } : {}) },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; name: string; sortOrder: number; linkCount: number };
}

test("标签全部端点需要 admin", async () => {
  for (const req of [
    { method: "GET" as const, url: "/admin/link-tags" },
    { method: "POST" as const, url: "/admin/link-tags", payload: { name: "x" } },
    { method: "PATCH" as const, url: "/admin/link-tags/x", payload: { name: "x" } },
    { method: "DELETE" as const, url: "/admin/link-tags/x" },
  ]) {
    expect((await app.inject(req)).statusCode).toBe(401);
  }
});

test("新增/列表按 sortOrder;重名与改名撞重名 409", async () => {
  const guide = await makeTag("实用攻略", 0);
  await makeTag("旅行记录", 1);

  const dup = await app.inject({
    method: "POST", url: "/admin/link-tags", headers: ADMIN_AUTH, payload: { name: "实用攻略" },
  });
  expect(dup.statusCode).toBe(409);
  expect(dup.json().error).toBe("duplicate_name");

  const renamed = await app.inject({
    method: "PATCH", url: `/admin/link-tags/${guide.id}`, headers: ADMIN_AUTH,
    payload: { name: "攻略" },
  });
  expect(renamed.statusCode).toBe(200);
  expect(renamed.json().name).toBe("攻略");

  const clash = await app.inject({
    method: "PATCH", url: `/admin/link-tags/${guide.id}`, headers: ADMIN_AUTH,
    payload: { name: "旅行记录" },
  });
  expect(clash.statusCode).toBe(409);

  const list = await app.inject({ method: "GET", url: "/admin/link-tags", headers: ADMIN_AUTH });
  expect(list.json().map((t: { name: string }) => t.name)).toEqual(["攻略", "旅行记录"]);
  expect(list.json()[0].linkCount).toBe(0);
});

test("空名/纯空白/超长名 400;PATCH 空对象 400;不存在 404", async () => {
  for (const name of ["", "   ", "一二三四五六七八九十一二三"]) {
    const res = await app.inject({
      method: "POST", url: "/admin/link-tags", headers: ADMIN_AUTH, payload: { name },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  }
  const tag = await makeTag("攻略");
  const empty = await app.inject({
    method: "PATCH", url: `/admin/link-tags/${tag.id}`, headers: ADMIN_AUTH, payload: {},
  });
  expect(empty.statusCode).toBe(400);
  const missing = await app.inject({
    method: "PATCH", url: "/admin/link-tags/nope", headers: ADMIN_AUTH, payload: { name: "x" },
  });
  expect(missing.statusCode).toBe(404);
});

test("删除:未引用 204;被引用 409 tag_in_use 且带计数", async () => {
  const tag = await makeTag("攻略");
  const place = await app.prisma.place.create({
    data: { name: "香港", level: "CITY", lat: 22.32, lng: 114.17 },
  });
  await app.prisma.placeLink.create({
    data: { placeId: place.id, platform: "BILIBILI", title: "x", url: "https://e.com/a", tagId: tag.id },
  });
  const inUse = await app.inject({
    method: "DELETE", url: `/admin/link-tags/${tag.id}`, headers: ADMIN_AUTH,
  });
  expect(inUse.statusCode).toBe(409);
  expect(inUse.json()).toEqual({ error: "tag_in_use", detail: { linkCount: 1 } });

  await app.prisma.placeLink.deleteMany({});
  const ok = await app.inject({
    method: "DELETE", url: `/admin/link-tags/${tag.id}`, headers: ADMIN_AUTH,
  });
  expect(ok.statusCode).toBe(204);
  expect(await app.prisma.placeLinkTag.count()).toBe(0);
});
