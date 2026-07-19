import { afterAll, beforeEach, expect, test } from "vitest";
import { ADMIN_AUTH, resetDb, testApp } from "./helpers.js";

const app = testApp();
beforeEach(() => resetDb(app));
afterAll(async () => app.close());

/** 两省树：河北省→保定市→莲池区→直隶总督署；山东省→济南市→大明湖 */
async function makeTree() {
  const hebei = await app.prisma.place.create({
    data: { name: "河北省", level: "PROVINCE", lat: 38.04, lng: 114.51 },
  });
  const baoding = await app.prisma.place.create({
    data: { name: "保定市", level: "CITY", parentId: hebei.id, lat: 38.87, lng: 115.46 },
  });
  const lianchi = await app.prisma.place.create({
    data: { name: "莲池区", level: "DISTRICT", parentId: baoding.id, lat: 38.88, lng: 115.5 },
  });
  const zongdushu = await app.prisma.place.create({
    data: { name: "直隶总督署", level: "POI", parentId: lianchi.id, lat: 38.874, lng: 115.49 },
  });
  const shandong = await app.prisma.place.create({
    data: { name: "山东省", level: "PROVINCE", lat: 36.67, lng: 117.02 },
  });
  const jinan = await app.prisma.place.create({
    data: { name: "济南市", level: "CITY", parentId: shandong.id, lat: 36.65, lng: 117.12 },
  });
  const daminghu = await app.prisma.place.create({
    data: { name: "大明湖", level: "POI", parentId: jinan.id, lat: 36.678, lng: 117.02 },
  });
  return { hebei, baoding, lianchi, zongdushu, shandong, jinan, daminghu };
}

type CardOver = {
  title?: string;
  category?: "CUSTOMS" | "FOOD" | "DIALECT" | "ANECDOTE" | "PLACE_NAME";
  status?: "AI_GENERATED" | "REVIEWED" | "RETIRED";
  createdAt?: Date;
};

function makeCard(placeId: string, over: CardOver = {}) {
  return app.prisma.card.create({
    data: {
      placeId,
      category: over.category ?? "ANECDOTE",
      title: over.title ?? "无题",
      status: over.status ?? "AI_GENERATED",
      sources: [],
      ...(over.createdAt ? { createdAt: over.createdAt } : {}),
    },
  });
}

function list(query: string) {
  return app.inject({ method: "GET", url: `/admin/cards${query}`, headers: ADMIN_AUTH });
}

test("under 子树筛选：含自身与全部子孙，兄弟省不串", async () => {
  const t = await makeTree();
  await makeCard(t.hebei.id, { title: "省卡" });
  await makeCard(t.baoding.id, { title: "市卡" });
  await makeCard(t.lianchi.id, { title: "区卡" });
  await makeCard(t.zongdushu.id, { title: "POI卡" });
  await makeCard(t.daminghu.id, { title: "外省卡" });

  const province = (await list(`?under=${t.hebei.id}`)).json();
  expect(province.total).toBe(4);
  expect(province.items.map((c: { title: string }) => c.title)).not.toContain("外省卡");

  expect((await list(`?under=${t.baoding.id}`)).json().total).toBe(3);

  const poi = (await list(`?under=${t.zongdushu.id}`)).json();
  expect(poi.total).toBe(1);
  expect(poi.items[0].placeName).toBe("直隶总督署");
});

test("分类/状态/关键字筛选；RETIRED 默认可见", async () => {
  const t = await makeTree();
  await makeCard(t.zongdushu.id, { title: "总督署掌故", category: "ANECDOTE", status: "REVIEWED" });
  await makeCard(t.zongdushu.id, { title: "Baoding驴肉火烧", category: "FOOD", status: "AI_GENERATED" });
  await makeCard(t.zongdushu.id, { title: "已退休的卡", category: "FOOD", status: "RETIRED" });

  expect((await list("")).json().total).toBe(3); // 不传 status = 全部，含 RETIRED

  expect((await list("?category=FOOD")).json().total).toBe(2);

  const retired = (await list("?status=RETIRED")).json();
  expect(retired.total).toBe(1);
  expect(retired.items[0].title).toBe("已退休的卡");

  const kw = (await list("?q=baoding")).json(); // 大小写不敏感 contains
  expect(kw.total).toBe(1);
  expect(kw.items[0].title).toBe("Baoding驴肉火烧");

  const combo = (await list(`?under=${t.hebei.id}&category=FOOD&status=AI_GENERATED`)).json();
  expect(combo.total).toBe(1);
});

test("分页稳定（createdAt desc）与轻 DTO（无 blocks/sources）", async () => {
  const t = await makeTree();
  await makeCard(t.zongdushu.id, { title: "第一张", createdAt: new Date("2026-07-01T00:00:00Z") });
  await makeCard(t.zongdushu.id, { title: "第二张", createdAt: new Date("2026-07-02T00:00:00Z") });
  const third = await makeCard(t.zongdushu.id, {
    title: "第三张", createdAt: new Date("2026-07-03T00:00:00Z"),
  });
  await app.prisma.cardBlock.create({
    data: { cardId: third.id, type: "TEXT", text: "正文", order: 0 },
  });

  const page1 = (await list("?pageSize=2&page=1")).json();
  expect(page1.total).toBe(3);
  expect(page1.items.map((c: { title: string }) => c.title)).toEqual(["第三张", "第二张"]);
  const page2 = (await list("?pageSize=2&page=2")).json();
  expect(page2.items.map((c: { title: string }) => c.title)).toEqual(["第一张"]);

  // 轻 DTO 回归：即使卡带 blocks，列表项也不携带 blocks/sources，且带 placeName
  const serialized = JSON.stringify(page1);
  expect(serialized).not.toContain("blocks");
  expect(serialized).not.toContain("sources");
  expect(page1.items[0].placeName).toBe("直隶总督署");
});

test("未鉴权 401；非法参数 400；under 不存在返回空集", async () => {
  const anon = await app.inject({ method: "GET", url: "/admin/cards" });
  expect(anon.statusCode).toBe(401);

  expect((await list("?page=0")).statusCode).toBe(400);
  expect((await list("?pageSize=999")).statusCode).toBe(400);
  expect((await list("?status=NOPE")).statusCode).toBe(400);

  const ghost = await list("?under=no-such-place");
  expect(ghost.statusCode).toBe(200);
  expect(ghost.json()).toEqual({ total: 0, items: [] });
});
