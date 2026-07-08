import { afterAll, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { appleJwks, TEST_DB_URL } from "./helpers.js";

const app = buildApp({
  databaseUrl: TEST_DB_URL,
  appleJwks,
  devAuth: true,
  s3Bucket: "zhixing-test",
  rateLimit: { max: 3 },
});
afterAll(async () => app.close());

test("超过 max 次/分钟 → 429；未超限时正常放行", async () => {
  for (let i = 0; i < 3; i++) {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  }
  const fourth = await app.inject({ method: "GET", url: "/health" });
  expect(fourth.statusCode).toBe(429);
});

test("不同 Authorization 头各自独立计数", async () => {
  for (let i = 0; i < 3; i++) {
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { authorization: "Bearer user-a" },
    });
    expect(res.statusCode).toBe(200);
  }
  const aExceeded = await app.inject({
    method: "GET",
    url: "/health",
    headers: { authorization: "Bearer user-a" },
  });
  expect(aExceeded.statusCode).toBe(429);

  // 不同 Authorization 头独立计数，不受用户 A 超限影响
  const bFirst = await app.inject({
    method: "GET",
    url: "/health",
    headers: { authorization: "Bearer user-b" },
  });
  expect(bFirst.statusCode).toBe(200);
});
