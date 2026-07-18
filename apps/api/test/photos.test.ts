import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { afterAll, beforeEach, expect, test } from "vitest";
import { resetDb, testApp, TEST_S3_BUCKET, userAuth } from "./helpers.js";

const app = testApp();
beforeEach(() => resetDb(app));
afterAll(async () => app.close());

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const rawS3 = new S3Client({
  endpoint: "http://localhost:9000",
  region: "us-east-1",
  forcePathStyle: true,
  credentials: { accessKeyId: "zhixing", secretAccessKey: "zhixing-secret" },
});

/** meta 校验须先于 storage.put——用来断言非法 meta 请求没有在 MinIO 里留孤儿对象。 */
async function countStorageObjects(prefix: string): Promise<number> {
  const res = await rawS3.send(
    new ListObjectsV2Command({ Bucket: TEST_S3_BUCKET, Prefix: prefix }),
  );
  return res.Contents?.length ?? 0;
}

function multipartPayload(fields: Record<string, string>, fileBuf: Buffer, mime: string) {
  const boundary = "----zx-test-boundary";
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(Buffer.from(
    `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="p.png"\r\ncontent-type: ${mime}\r\n\r\n`,
  ));
  parts.push(fileBuf, Buffer.from(`\r\n--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(parts),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

async function makeFootprint(headers: Record<string, string>) {
  const place = await app.prisma.place.create({
    data: { name: "什刹海", level: "DISTRICT", lat: 39.94, lng: 116.38 },
  });
  const res = await app.inject({
    method: "POST", url: "/footprints", headers,
    payload: { placeId: place.id, date: "2026-05-01T10:00:00.000Z" },
  });
  return res.json().id as string;
}

test("上传照片并经 presigned URL 取回", async () => {
  const { headers } = await userAuth(app);
  const fpId = await makeFootprint(headers);

  const mp = multipartPayload(
    { takenAt: "2026-05-01T09:30:00.000Z", lat: "39.94", lng: "116.38" }, PNG_1PX, "image/png",
  );
  const up = await app.inject({
    method: "POST", url: `/footprints/${fpId}/photos`,
    headers: { ...headers, ...mp.headers }, payload: mp.payload,
  });
  expect(up.statusCode).toBe(201);

  const photo = await app.prisma.footprintPhoto.findFirstOrThrow();
  expect(photo.mediaUrl).toMatch(new RegExp(`^photos/${fpId}/.+\\.png$`));
  expect(photo.lat).toBeCloseTo(39.94);

  const get = await app.inject({ method: "GET", url: `/photos/${up.json().id}`, headers });
  expect(get.statusCode).toBe(200);
  const fetched = await fetch(get.json().url);
  expect(fetched.status).toBe(200);
  expect(Buffer.from(await fetched.arrayBuffer()).equals(PNG_1PX)).toBe(true);
});

test("MIME 白名单外 415；别人的足迹传不了、照片读不到", async () => {
  const alice = await userAuth(app, "alice");
  const bob = await userAuth(app, "bob");
  const fpId = await makeFootprint(alice.headers);

  const gif = multipartPayload({}, PNG_1PX, "image/gif");
  expect(
    (await app.inject({
      method: "POST", url: `/footprints/${fpId}/photos`,
      headers: { ...alice.headers, ...gif.headers }, payload: gif.payload,
    })).statusCode,
  ).toBe(415);

  const mp = multipartPayload({}, PNG_1PX, "image/png");
  expect(
    (await app.inject({
      method: "POST", url: `/footprints/${fpId}/photos`,
      headers: { ...bob.headers, ...mp.headers }, payload: mp.payload,
    })).statusCode,
  ).toBe(404);

  const ok = await app.inject({
    method: "POST", url: `/footprints/${fpId}/photos`,
    headers: { ...alice.headers, ...mp.headers }, payload: mp.payload,
  });
  expect(
    (await app.inject({ method: "GET", url: `/photos/${ok.json().id}`, headers: bob.headers })).statusCode,
  ).toBe(404);
});

test("photos 授权矩阵：陌生人 + 私密 → 404；陌生人 + PUBLIC+APPROVED → 200 含 url", async () => {
  const alice = await userAuth(app, "alice2");
  const bob = await userAuth(app, "bob2");

  const privateFpId = await makeFootprint(alice.headers);
  const mpPrivate = multipartPayload({}, PNG_1PX, "image/png");
  const privateUp = await app.inject({
    method: "POST", url: `/footprints/${privateFpId}/photos`,
    headers: { ...alice.headers, ...mpPrivate.headers }, payload: mpPrivate.payload,
  });
  expect(
    (await app.inject({ method: "GET", url: `/photos/${privateUp.json().id}`, headers: bob.headers })).statusCode,
  ).toBe(404);

  const place = await app.prisma.place.create({
    data: { name: "公开测试地", level: "DISTRICT", lat: 1, lng: 1 },
  });
  const publicFp = await app.prisma.footprint.create({
    data: {
      userId: alice.user.id, placeId: place.id, date: new Date("2026-05-01T10:00:00.000Z"),
      visibility: "PUBLIC", reviewStatus: "APPROVED",
    },
  });
  const mpPublic = multipartPayload({}, PNG_1PX, "image/png");
  const publicUp = await app.inject({
    method: "POST", url: `/footprints/${publicFp.id}/photos`,
    headers: { ...alice.headers, ...mpPublic.headers }, payload: mpPublic.payload,
  });
  // C1：上传照片使公开态足迹回 PENDING（内容变更须重审）；模拟管理员再次通过后陌生人才可读图。
  await app.prisma.footprint.update({
    where: { id: publicFp.id }, data: { reviewStatus: "APPROVED" },
  });
  const publicGet = await app.inject({
    method: "GET", url: `/photos/${publicUp.json().id}`, headers: bob.headers,
  });
  expect(publicGet.statusCode).toBe(200);
  expect(publicGet.json().url).toBeTruthy();
});

test("C1：向 PUBLIC+APPROVED 足迹上传照片 → 回 PENDING 且从公开 stories 消失", async () => {
  const alice = await userAuth(app, "aliceC1");
  const viewer = await userAuth(app, "viewerC1");
  const place = await app.prisma.place.create({
    data: { name: "审核绕过测试地", level: "DISTRICT", lat: 2, lng: 2 },
  });
  const fp = await app.prisma.footprint.create({
    data: {
      userId: alice.user.id, placeId: place.id, date: new Date("2026-05-01T10:00:00.000Z"),
      visibility: "PUBLIC", reviewStatus: "APPROVED", publicRequestedAt: new Date("2020-01-01T00:00:00.000Z"),
      text: "已过审的公开故事",
    },
  });

  // 上传前：出现在公开 stories。
  const before = await app.inject({
    method: "GET", url: `/places/${place.id}/stories`, headers: viewer.headers,
  });
  expect(before.json().items.map((i: { footprintId: string }) => i.footprintId)).toContain(fp.id);

  const mp = multipartPayload({}, PNG_1PX, "image/png");
  const up = await app.inject({
    method: "POST", url: `/footprints/${fp.id}/photos`,
    headers: { ...alice.headers, ...mp.headers }, payload: mp.payload,
  });
  expect(up.statusCode).toBe(201);

  // 库里状态回 PENDING，publicRequestedAt 被刷新。
  const row = await app.prisma.footprint.findUniqueOrThrow({ where: { id: fp.id } });
  expect(row.reviewStatus).toBe("PENDING");
  expect(row.publicRequestedAt!.getTime()).toBeGreaterThan(new Date("2020-01-01T00:00:00.000Z").getTime());

  // 不再出现在公开 stories。
  const after = await app.inject({
    method: "GET", url: `/places/${place.id}/stories`, headers: viewer.headers,
  });
  expect(after.json().items.map((i: { footprintId: string }) => i.footprintId)).not.toContain(fp.id);
});

test("C1：私密足迹上传照片不改状态（reviewStatus 原样保留）", async () => {
  const alice = await userAuth(app, "alicePriv");
  const fpId = await makeFootprint(alice.headers); // 默认 PRIVATE
  const before = await app.prisma.footprint.findUniqueOrThrow({ where: { id: fpId } });

  const mp = multipartPayload({}, PNG_1PX, "image/png");
  const up = await app.inject({
    method: "POST", url: `/footprints/${fpId}/photos`,
    headers: { ...alice.headers, ...mp.headers }, payload: mp.payload,
  });
  expect(up.statusCode).toBe(201);

  const after = await app.prisma.footprint.findUniqueOrThrow({ where: { id: fpId } });
  expect(after.reviewStatus).toBe(before.reviewStatus);
  expect(after.publicRequestedAt).toEqual(before.publicRequestedAt);
});

test("meta 非法（takenAt 非 ISO8601 / lat·lng 越界）→ 400 invalid_photo_meta", async () => {
  const { headers } = await userAuth(app);
  const fpId = await makeFootprint(headers);

  const badDate = multipartPayload({ takenAt: "not-a-date" }, PNG_1PX, "image/png");
  const r1 = await app.inject({
    method: "POST", url: `/footprints/${fpId}/photos`,
    headers: { ...headers, ...badDate.headers }, payload: badDate.payload,
  });
  expect(r1.statusCode).toBe(400);
  expect(r1.json().error).toBe("invalid_photo_meta");

  const badLat = multipartPayload({ lat: "999" }, PNG_1PX, "image/png");
  const r2 = await app.inject({
    method: "POST", url: `/footprints/${fpId}/photos`,
    headers: { ...headers, ...badLat.headers }, payload: badLat.payload,
  });
  expect(r2.statusCode).toBe(400);
  expect(r2.json().error).toBe("invalid_photo_meta");

  const badLng = multipartPayload({ lng: "-181" }, PNG_1PX, "image/png");
  const r3 = await app.inject({
    method: "POST", url: `/footprints/${fpId}/photos`,
    headers: { ...headers, ...badLng.headers }, payload: badLng.payload,
  });
  expect(r3.statusCode).toBe(400);
  expect(r3.json().error).toBe("invalid_photo_meta");

  // 未上传任何合法照片记录，且 meta 校验先于 storage.put——MinIO 里也不该留孤儿对象。
  expect(await app.prisma.footprintPhoto.count()).toBe(0);
  expect(await countStorageObjects(`photos/${fpId}/`)).toBe(0);
});

test("照片顺序=上传顺序，私密/故事/照片墙三面一致；orderIndex 不下发", async () => {
  const alice = await userAuth(app, "aliceOrder");
  const viewer = await userAuth(app, "viewerOrder");
  const fpId = await makeFootprint(alice.headers);

  // 逐张上传 3 张，记录返回 id 的顺序（即上传顺序）。
  const uploadedIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const mp = multipartPayload({}, PNG_1PX, "image/png");
    const up = await app.inject({
      method: "POST", url: `/footprints/${fpId}/photos`,
      headers: { ...alice.headers, ...mp.headers }, payload: mp.payload,
    });
    expect(up.statusCode).toBe(201);
    uploadedIds.push(up.json().id as string);
  }

  // 私密面：/me/footprints 的 photos id 序 = 上传序。
  const mine = await app.inject({ method: "GET", url: "/me/footprints", headers: alice.headers });
  const mineFp = mine.json().find((f: { id: string }) => f.id === fpId);
  expect(mineFp.photos.map((p: { id: string }) => p.id)).toEqual(uploadedIds);

  // 直改库进公开态，公开两面（stories / photo-wall）顺序须与私密面完全一致。
  await app.prisma.footprint.update({
    where: { id: fpId }, data: { visibility: "PUBLIC", reviewStatus: "APPROVED" },
  });
  const { placeId } = await app.prisma.footprint.findUniqueOrThrow({
    where: { id: fpId }, select: { placeId: true },
  });

  const stories = await app.inject({
    method: "GET", url: `/places/${placeId}/stories`, headers: viewer.headers,
  });
  const story = stories.json().items.find((i: { footprintId: string }) => i.footprintId === fpId);
  expect(story.photos.map((p: { photoId: string }) => p.photoId)).toEqual(uploadedIds);

  // 照片墙此前是 id desc（spec §0 的 bug），此处断言不再翻转：组内序 = 上传序。
  const wall = await app.inject({
    method: "GET", url: `/places/${placeId}/photo-wall`, headers: viewer.headers,
  });
  const wallPhotos = wall.json().groups
    .flatMap((g: { photos: { photoId: string; footprintId: string }[] }) => g.photos)
    .filter((p: { footprintId: string }) => p.footprintId === fpId);
  expect(wallPhotos.map((p: { photoId: string }) => p.photoId)).toEqual(uploadedIds);

  // spec §2：orderIndex 序号列不下发，顺序仅由数组序表达。
  expect(JSON.stringify(stories.json())).not.toContain("orderIndex");
  expect(JSON.stringify(wall.json())).not.toContain("orderIndex");
});

test("已有 9 张再传第 10 张 → 400 photo_limit_reached，不写库不落盘", async () => {
  const { headers } = await userAuth(app, "aliceLimit");
  const fpId = await makeFootprint(headers);
  await app.prisma.footprintPhoto.createMany({
    data: Array.from({ length: 9 }, (_, i) => ({
      footprintId: fpId, mediaUrl: `photos/seed-${i}.jpg`,
    })),
  });

  const mp = multipartPayload({}, PNG_1PX, "image/png");
  const res = await app.inject({
    method: "POST", url: `/footprints/${fpId}/photos`,
    headers: { ...headers, ...mp.headers }, payload: mp.payload,
  });
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toBe("photo_limit_reached");
  // DB 行数仍 9；上限校验先于 storage.put——MinIO 里不留孤儿对象。
  expect(await app.prisma.footprintPhoto.count({ where: { footprintId: fpId } })).toBe(9);
  expect(await countStorageObjects(`photos/${fpId}/`)).toBe(0);
});

test("属主删除单张照片：204、DB 只剩另一张、S3 对象被清；删到 0 足迹本体仍在", async () => {
  const alice = await userAuth(app, "aliceDel");
  const fpId = await makeFootprint(alice.headers);

  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const mp = multipartPayload({}, PNG_1PX, "image/png");
    const up = await app.inject({
      method: "POST", url: `/footprints/${fpId}/photos`,
      headers: { ...alice.headers, ...mp.headers }, payload: mp.payload,
    });
    expect(up.statusCode).toBe(201);
    ids.push(up.json().id as string);
  }
  expect(await countStorageObjects(`photos/${fpId}/`)).toBe(2);

  // 删第 1 张：DB 剩 1 行且是第 2 张；storage.remove 是 await 的，响应返回时对象已清。
  const del1 = await app.inject({ method: "DELETE", url: `/photos/${ids[0]}`, headers: alice.headers });
  expect(del1.statusCode).toBe(204);
  const rest = await app.prisma.footprintPhoto.findMany({ where: { footprintId: fpId } });
  expect(rest.map((p) => p.id)).toEqual([ids[1]]);
  expect(await countStorageObjects(`photos/${fpId}/`)).toBe(1);

  // 删到 0：足迹本体不受影响，photos 变空数组。
  const del2 = await app.inject({ method: "DELETE", url: `/photos/${ids[1]}`, headers: alice.headers });
  expect(del2.statusCode).toBe(204);
  const mine = await app.inject({ method: "GET", url: "/me/footprints", headers: alice.headers });
  const mineFp = mine.json().find((f: { id: string }) => f.id === fpId);
  expect(mineFp).toBeTruthy();
  expect(mineFp.photos).toEqual([]);
});

test("非属主删照片 → 404 且行还在;不存在的 photoId → 404", async () => {
  const alice = await userAuth(app, "aliceDel2");
  const bob = await userAuth(app, "bobDel2");
  const fpId = await makeFootprint(alice.headers);

  const mp = multipartPayload({}, PNG_1PX, "image/png");
  const up = await app.inject({
    method: "POST", url: `/footprints/${fpId}/photos`,
    headers: { ...alice.headers, ...mp.headers }, payload: mp.payload,
  });
  const photoId = up.json().id as string;

  // 把足迹置为 PUBLIC+APPROVED（直写 DB，同文件宽松重审用例先例）：
  // 删除仅属主可为——即便照片确已在公开面可读，非属主删一律 404。
  await app.prisma.footprint.update({
    where: { id: fpId },
    data: { visibility: "PUBLIC", reviewStatus: "APPROVED" },
  });
  const res = await app.inject({ method: "DELETE", url: `/photos/${photoId}`, headers: bob.headers });
  expect(res.statusCode).toBe(404);
  expect(res.json().error).toBe("not_found");
  expect(await app.prisma.footprintPhoto.count({ where: { id: photoId } })).toBe(1);

  const missing = await app.inject({
    method: "DELETE", url: "/photos/nonexistent-photo-id", headers: alice.headers,
  });
  expect(missing.statusCode).toBe(404);
  expect(missing.json().error).toBe("not_found");
});

test("宽松重审策略：PUBLIC+APPROVED 足迹删照片不回审（reviewStatus / publicRequestedAt 原样）", async () => {
  const alice = await userAuth(app, "aliceDelPub");
  const place = await app.prisma.place.create({
    data: { name: "删图不回审测试地", level: "DISTRICT", lat: 3, lng: 3 },
  });
  const fp = await app.prisma.footprint.create({
    data: {
      userId: alice.user.id, placeId: place.id, date: new Date("2026-05-01T10:00:00.000Z"),
      visibility: "PUBLIC", reviewStatus: "APPROVED",
      publicRequestedAt: new Date("2020-01-01T00:00:00.000Z"),
    },
  });
  const photo = await app.prisma.footprintPhoto.create({
    data: { footprintId: fp.id, mediaUrl: `photos/${fp.id}/seed.png` },
  });
  const before = await app.prisma.footprint.findUniqueOrThrow({ where: { id: fp.id } });

  const res = await app.inject({ method: "DELETE", url: `/photos/${photo.id}`, headers: alice.headers });
  expect(res.statusCode).toBe(204);

  // spec §3 宽松重审：删图不引入未审内容，不触发回审。
  const after = await app.prisma.footprint.findUniqueOrThrow({ where: { id: fp.id } });
  expect(after.reviewStatus).toBe("APPROVED");
  expect(after.publicRequestedAt).toEqual(before.publicRequestedAt);
});

/** 直插 DB 造 n 张有序照片（orderIndex=插入序），免走 MinIO 上传，返回 id 按序。 */
async function seedOrderedPhotos(fpId: string, n: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const p = await app.prisma.footprintPhoto.create({
      data: { footprintId: fpId, mediaUrl: `photos/${fpId}/seed-${i}.png`, orderIndex: i },
    });
    ids.push(p.id);
  }
  return ids;
}

async function myPhotoIds(fpId: string, headers: Record<string, string>): Promise<string[]> {
  const mine = await app.inject({ method: "GET", url: "/me/footprints", headers });
  const fp = mine.json().find((f: { id: string }) => f.id === fpId);
  return fp.photos.map((p: { id: string }) => p.id);
}

test("全量重排：3 张倒序 PUT → 204，/me/footprints 序=新序；同排列再 PUT 幂等", async () => {
  const alice = await userAuth(app, "aliceReorder");
  const fpId = await makeFootprint(alice.headers);
  const ids = await seedOrderedPhotos(fpId, 3);

  const reversed = [...ids].reverse();
  const res = await app.inject({
    method: "PUT", url: `/footprints/${fpId}/photos/order`,
    headers: alice.headers, payload: { photoIds: reversed },
  });
  expect(res.statusCode).toBe(204);
  expect(await myPhotoIds(fpId, alice.headers)).toEqual(reversed);

  // 幂等：同一排列再 PUT，仍 204，序不变。
  const again = await app.inject({
    method: "PUT", url: `/footprints/${fpId}/photos/order`,
    headers: alice.headers, payload: { photoIds: reversed },
  });
  expect(again.statusCode).toBe(204);
  expect(await myPhotoIds(fpId, alice.headers)).toEqual(reversed);
});

test("集合不等三连：缺一张 / 多陌生 id / 含重复 id → 400 photo_set_mismatch，DB 序不变", async () => {
  const alice = await userAuth(app, "aliceMismatch");
  const fpId = await makeFootprint(alice.headers);
  const ids = await seedOrderedPhotos(fpId, 3);

  const badSets = [
    [ids[2], ids[0]],                       // 缺一张
    [ids[2], ids[1], ids[0], "stranger-id"], // 多一个陌生 id
    [ids[2], ids[1], ids[1]],               // 含重复 id（去重后长度 < 原长）
  ];
  for (const photoIds of badSets) {
    const res = await app.inject({
      method: "PUT", url: `/footprints/${fpId}/photos/order`,
      headers: alice.headers, payload: { photoIds },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: "invalid_body", detail: "photo_set_mismatch" });
  }
  // 三次非法请求都不该动库里顺序。
  expect(await myPhotoIds(fpId, alice.headers)).toEqual(ids);
});

test("非属主重排 → 404；足迹不存在 → 404", async () => {
  const alice = await userAuth(app, "aliceReorderOwn");
  const bob = await userAuth(app, "bobReorderOwn");
  const fpId = await makeFootprint(alice.headers);
  const ids = await seedOrderedPhotos(fpId, 2);

  const res = await app.inject({
    method: "PUT", url: `/footprints/${fpId}/photos/order`,
    headers: bob.headers, payload: { photoIds: [...ids].reverse() },
  });
  expect(res.statusCode).toBe(404);
  expect(res.json().error).toBe("not_found");
  expect(await myPhotoIds(fpId, alice.headers)).toEqual(ids);

  const missing = await app.inject({
    method: "PUT", url: "/footprints/nonexistent-fp/photos/order",
    headers: alice.headers, payload: { photoIds: [] },
  });
  expect(missing.statusCode).toBe(404);
  expect(missing.json().error).toBe("not_found");
});

test("宽松重审：PUBLIC+APPROVED 足迹重排不回审，公开 stories 序跟随新序", async () => {
  const alice = await userAuth(app, "aliceReorderPub");
  const viewer = await userAuth(app, "viewerReorderPub");
  const place = await app.prisma.place.create({
    data: { name: "重排不回审测试地", level: "DISTRICT", lat: 4, lng: 4 },
  });
  const fp = await app.prisma.footprint.create({
    data: {
      userId: alice.user.id, placeId: place.id, date: new Date("2026-05-01T10:00:00.000Z"),
      visibility: "PUBLIC", reviewStatus: "APPROVED",
      publicRequestedAt: new Date("2020-01-01T00:00:00.000Z"),
    },
  });
  const ids = await seedOrderedPhotos(fp.id, 3);
  const before = await app.prisma.footprint.findUniqueOrThrow({ where: { id: fp.id } });

  const reversed = [...ids].reverse();
  const res = await app.inject({
    method: "PUT", url: `/footprints/${fp.id}/photos/order`,
    headers: alice.headers, payload: { photoIds: reversed },
  });
  expect(res.statusCode).toBe(204);

  // spec §3 宽松重审：排序只变展示序、集合未变，不触发回审。
  const after = await app.prisma.footprint.findUniqueOrThrow({ where: { id: fp.id } });
  expect(after.reviewStatus).toBe("APPROVED");
  expect(after.publicRequestedAt).toEqual(before.publicRequestedAt);

  // 公开面跟随：stories 照片序 = 新序。
  const stories = await app.inject({
    method: "GET", url: `/places/${place.id}/stories`, headers: viewer.headers,
  });
  const story = stories.json().items.find((i: { footprintId: string }) => i.footprintId === fp.id);
  expect(story.photos.map((p: { photoId: string }) => p.photoId)).toEqual(reversed);
});

test("0 张足迹 + photoIds: [] → 204 no-op；body 非法 → 400 invalid_body", async () => {
  const alice = await userAuth(app, "aliceReorderEmpty");
  const fpId = await makeFootprint(alice.headers);

  const res = await app.inject({
    method: "PUT", url: `/footprints/${fpId}/photos/order`,
    headers: alice.headers, payload: { photoIds: [] },
  });
  expect(res.statusCode).toBe(204);

  const bad = await app.inject({
    method: "PUT", url: `/footprints/${fpId}/photos/order`,
    headers: alice.headers, payload: { photoIds: "not-an-array" },
  });
  expect(bad.statusCode).toBe(400);
  expect(bad.json().error).toBe("invalid_body");
});

test("超过 15MB → 413（fastify-multipart 文件大小限制固化）", async () => {
  const { headers } = await userAuth(app);
  const fpId = await makeFootprint(headers);
  const big = Buffer.alloc(16 * 1024 * 1024, 1);
  const mp = multipartPayload({}, big, "image/png");
  const res = await app.inject({
    method: "POST", url: `/footprints/${fpId}/photos`,
    headers: { ...headers, ...mp.headers }, payload: mp.payload,
  });
  expect(res.statusCode).toBe(413);
});
