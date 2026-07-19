import { afterAll, beforeEach, expect, test } from "vitest";
import { placeSubtreeIds } from "../src/placeSubtree.js";
import { resetDb, testApp } from "./helpers.js";

const app = testApp();
beforeEach(() => resetDb(app));
afterAll(async () => app.close());

test("子树展开：含根自身与全部子孙，不含兄弟；根不存在退化为 [rootId]", async () => {
  const prov = await app.prisma.place.create({
    data: { name: "甲省", level: "PROVINCE", lat: 30, lng: 110 },
  });
  const city = await app.prisma.place.create({
    data: { name: "乙市", level: "CITY", parentId: prov.id, lat: 30, lng: 110 },
  });
  const poi = await app.prisma.place.create({
    data: { name: "丙点", level: "POI", parentId: city.id, lat: 30, lng: 110 },
  });
  const other = await app.prisma.place.create({
    data: { name: "丁省", level: "PROVINCE", lat: 31, lng: 111 },
  });

  const ids = await placeSubtreeIds(app.prisma, prov.id);
  expect(new Set(ids)).toEqual(new Set([prov.id, city.id, poi.id]));
  expect(ids).not.toContain(other.id);

  expect(await placeSubtreeIds(app.prisma, poi.id)).toEqual([poi.id]);
  expect(await placeSubtreeIds(app.prisma, "ghost")).toEqual(["ghost"]);
});

test("脏数据成环不死循环", async () => {
  // 管理接口有 cyclic_parent 防护，这里绕过路由直写库造环
  const a = await app.prisma.place.create({
    data: { name: "环甲", level: "CITY", lat: 30, lng: 110 },
  });
  const b = await app.prisma.place.create({
    data: { name: "环乙", level: "CITY", parentId: a.id, lat: 30, lng: 110 },
  });
  await app.prisma.place.update({ where: { id: a.id }, data: { parentId: b.id } });

  const ids = await placeSubtreeIds(app.prisma, a.id);
  expect(new Set(ids)).toEqual(new Set([a.id, b.id]));
});
