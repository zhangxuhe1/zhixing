import { afterAll, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { appleJwks, TEST_DB_URL, TEST_S3_BUCKET, testApp } from "./helpers.js";

const app = testApp();
afterAll(async () => app.close());

test("GET /health 返回 ok", async () => {
  const res = await app.inject({ method: "GET", url: "/health" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
});

test("trustProxy:true 是纯透传配置，不影响启动：/health 仍 200", async () => {
  const trustProxyApp = buildApp({
    databaseUrl: TEST_DB_URL,
    appleJwks,
    s3Bucket: TEST_S3_BUCKET,
    rateLimit: false,
    trustProxy: true,
  });
  try {
    const res = await trustProxyApp.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
  } finally {
    await trustProxyApp.close();
  }
});
