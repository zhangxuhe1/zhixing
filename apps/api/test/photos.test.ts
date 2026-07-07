import { afterAll, beforeEach, expect, test } from "vitest";
import { resetDb, testApp, userAuth } from "./helpers.js";

const app = testApp();
beforeEach(() => resetDb(app));
afterAll(async () => app.close());

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

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
  const publicGet = await app.inject({
    method: "GET", url: `/photos/${publicUp.json().id}`, headers: bob.headers,
  });
  expect(publicGet.statusCode).toBe(200);
  expect(publicGet.json().url).toBeTruthy();
});
