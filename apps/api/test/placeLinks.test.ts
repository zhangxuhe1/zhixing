import { afterAll, beforeEach, expect, test } from "vitest";
import { ADMIN_AUTH, resetDb, testApp } from "./helpers.js";

const app = testApp();
beforeEach(() => resetDb(app));
afterAll(async () => app.close());

async function makePlace() {
  return app.prisma.place.create({
    data: { name: "什刹海", level: "DISTRICT", lat: 39.94, lng: 116.38 },
  });
}

test("外链 CRUD 需要 admin;detail 按 sortOrder 返回", async () => {
  const place = await makePlace();

  const noAuth = await app.inject({
    method: "POST", url: `/admin/places/${place.id}/links`,
    payload: { platform: "XIAOHONGSHU", title: "路线", url: "https://example.com/a" },
  });
  expect(noAuth.statusCode).toBe(401);

  const b = await app.inject({
    method: "POST", url: `/admin/places/${place.id}/links`, headers: ADMIN_AUTH,
    payload: { platform: "BILIBILI", title: "B 站探店", url: "https://example.com/b", sortOrder: 2 },
  });
  expect(b.statusCode).toBe(201);
  const a = await app.inject({
    method: "POST", url: `/admin/places/${place.id}/links`, headers: ADMIN_AUTH,
    payload: { platform: "XIAOHONGSHU", title: "citywalk 路线", url: "https://example.com/a", sortOrder: 1 },
  });
  expect(a.statusCode).toBe(201);

  const detail = await app.inject({ method: "GET", url: `/places/${place.id}` });
  expect(detail.json().links.map((l: { title: string }) => l.title)).toEqual([
    "citywalk 路线", "B 站探店",
  ]);
  // 外链 DTO 逐字段:不外传 placeId/createdAt
  expect(Object.keys(detail.json().links[0]).sort()).toEqual(
    ["id", "platform", "sortOrder", "title", "url"].sort(),
  );
});

test("url 必须 https;非法 platform 400", async () => {
  const place = await makePlace();
  for (const url of ["http://example.com/a", "javascript:alert(1)", "not-a-url"]) {
    const res = await app.inject({
      method: "POST", url: `/admin/places/${place.id}/links`, headers: ADMIN_AUTH,
      payload: { platform: "OTHER", title: "x", url },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  }
  const badPlatform = await app.inject({
    method: "POST", url: `/admin/places/${place.id}/links`, headers: ADMIN_AUTH,
    payload: { platform: "TIKTOK", title: "x", url: "https://example.com" },
  });
  expect(badPlatform.statusCode).toBe(400);
});

test("PATCH 改排序与标题;DELETE 删除;地点不存在 404", async () => {
  const place = await makePlace();
  const created = await app.inject({
    method: "POST", url: `/admin/places/${place.id}/links`, headers: ADMIN_AUTH,
    payload: { platform: "OTHER", title: "旧标题", url: "https://example.com/a" },
  });
  const linkId = created.json().id as string;

  const patched = await app.inject({
    method: "PATCH", url: `/admin/links/${linkId}`, headers: ADMIN_AUTH,
    payload: { title: "新标题", sortOrder: 5 },
  });
  expect(patched.statusCode).toBe(200);
  expect(patched.json().title).toBe("新标题");

  const del = await app.inject({ method: "DELETE", url: `/admin/links/${linkId}`, headers: ADMIN_AUTH });
  expect(del.statusCode).toBe(204);
  expect(await app.prisma.placeLink.count()).toBe(0);

  const missing = await app.inject({
    method: "POST", url: "/admin/places/nope/links", headers: ADMIN_AUTH,
    payload: { platform: "OTHER", title: "x", url: "https://example.com" },
  });
  expect(missing.statusCode).toBe(404);
});
