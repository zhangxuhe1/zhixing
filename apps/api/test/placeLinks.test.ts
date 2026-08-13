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
    ["id", "platform", "sortOrder", "tag", "title", "url"].sort(),
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

test("打标:POST/PATCH tagId;公开详情投影标签名;未知 tagId 400", async () => {
  const place = await makePlace();
  const tag = await app.prisma.placeLinkTag.create({ data: { name: "实用攻略" } });

  const created = await app.inject({
    method: "POST", url: `/admin/places/${place.id}/links`, headers: ADMIN_AUTH,
    payload: { platform: "BILIBILI", title: "200 元穷游香港", url: "https://example.com/hk", tagId: tag.id, sortOrder: 0 },
  });
  expect(created.statusCode).toBe(201);
  expect(created.json().tag).toEqual({ id: tag.id, name: "实用攻略" });

  const untagged = await app.inject({
    method: "POST", url: `/admin/places/${place.id}/links`, headers: ADMIN_AUTH,
    payload: { platform: "DOUYIN", title: "香港旅行记录", url: "https://example.com/hk2", sortOrder: 1 },
  });
  expect(untagged.json().tag).toBeNull();

  // 公开详情:已打标 → 标签名字符串;未打标 → null;全文不泄漏 tagId
  const detail = await app.inject({ method: "GET", url: `/places/${place.id}` });
  expect(detail.json().links.map((l: { tag: string | null }) => l.tag)).toEqual(["实用攻略", null]);
  expect(detail.body).not.toContain("tagId");

  // PATCH 取消标签;未知 tagId 400
  const linkId = created.json().id as string;
  const cleared = await app.inject({
    method: "PATCH", url: `/admin/links/${linkId}`, headers: ADMIN_AUTH, payload: { tagId: null },
  });
  expect(cleared.statusCode).toBe(200);
  expect(cleared.json().tag).toBeNull();

  const unknown = await app.inject({
    method: "PATCH", url: `/admin/links/${linkId}`, headers: ADMIN_AUTH, payload: { tagId: "nope" },
  });
  expect(unknown.statusCode).toBe(400);
  expect(unknown.json().error).toBe("unknown_tag");

  const unknownCreate = await app.inject({
    method: "POST", url: `/admin/places/${place.id}/links`, headers: ADMIN_AUTH,
    payload: { platform: "OTHER", title: "x", url: "https://example.com/x", tagId: "nope" },
  });
  expect(unknownCreate.statusCode).toBe(400);
  expect(unknownCreate.json().error).toBe("unknown_tag");
});

test("URL 首尾空白 trim 落库;trim 后非法仍 400", async () => {
  const place = await makePlace();
  const res = await app.inject({
    method: "POST", url: `/admin/places/${place.id}/links`, headers: ADMIN_AUTH,
    payload: { platform: "DOUYIN", title: "短链", url: " https://v.douyin.com/abc " },
  });
  expect(res.statusCode).toBe(201);
  expect(res.json().url).toBe("https://v.douyin.com/abc");
  expect((await app.prisma.placeLink.findFirstOrThrow()).url).toBe("https://v.douyin.com/abc");

  const bad = await app.inject({
    method: "POST", url: `/admin/places/${place.id}/links`, headers: ADMIN_AUTH,
    payload: { platform: "DOUYIN", title: "x", url: "   " },
  });
  expect(bad.statusCode).toBe(400);
});

test("GET /admin/places/:id/links:401/404/与公开详情同序", async () => {
  const place = await makePlace();
  expect((await app.inject({ method: "GET", url: `/admin/places/${place.id}/links` })).statusCode).toBe(401);
  expect((await app.inject({
    method: "GET", url: "/admin/places/nope/links", headers: ADMIN_AUTH,
  })).statusCode).toBe(404);

  // 相同 sortOrder 下按创建先后稳定排序,且与公开详情同序
  for (const title of ["第一条", "第二条"]) {
    await app.inject({
      method: "POST", url: `/admin/places/${place.id}/links`, headers: ADMIN_AUTH,
      payload: { platform: "OTHER", title, url: `https://example.com/${title}` },
    });
  }
  const admin = await app.inject({
    method: "GET", url: `/admin/places/${place.id}/links`, headers: ADMIN_AUTH,
  });
  expect(admin.statusCode).toBe(200);
  expect(admin.json().name).toBe("什刹海");
  expect(Array.isArray(admin.json().ancestors)).toBe(true);
  const adminIds = admin.json().links.map((l: { id: string }) => l.id);
  const publicIds = (await app.inject({ method: "GET", url: `/places/${place.id}` }))
    .json().links.map((l: { id: string }) => l.id);
  expect(adminIds).toEqual(publicIds);
  expect(admin.json().links.map((l: { title: string }) => l.title)).toEqual(["第一条", "第二条"]);
});

test("GET /admin/links:401/全量含地点路径与标签", async () => {
  expect((await app.inject({ method: "GET", url: "/admin/links" })).statusCode).toBe(401);

  const province = await app.prisma.place.create({
    data: { name: "北京市", level: "PROVINCE", lat: 39.9, lng: 116.4 },
  });
  const poi = await app.prisma.place.create({
    data: { name: "什刹海", level: "DISTRICT", parentId: province.id, lat: 39.94, lng: 116.38 },
  });
  const tag = await app.prisma.placeLinkTag.create({ data: { name: "旅行记录" } });
  await app.prisma.placeLink.create({
    data: { placeId: poi.id, platform: "DOUYIN", title: "漫步", url: "https://e.com/a", tagId: tag.id },
  });
  await app.prisma.placeLink.create({
    data: { placeId: province.id, platform: "BILIBILI", title: "未打标", url: "https://e.com/b" },
  });

  const res = await app.inject({ method: "GET", url: "/admin/links", headers: ADMIN_AUTH });
  expect(res.statusCode).toBe(200);
  const items = res.json().items as {
    title: string; tag: { name: string } | null; place: { id: string; path: string };
  }[];
  expect(items).toHaveLength(2);
  const walk = items.find((i) => i.title === "漫步")!;
  expect(walk.place.path).toBe("北京市 · 什刹海");
  expect(walk.tag?.name).toBe("旅行记录");
  expect(items.find((i) => i.title === "未打标")!.tag).toBeNull();
});
