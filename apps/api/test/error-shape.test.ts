import { afterAll, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { appleJwks, TEST_DB_URL, TEST_S3_BUCKET, testApp } from "./helpers.js";

// 统一错误形状（deploy.md 部署前硬化清单第 3 项）：框架级 404/413/500 也收敛为 { error }。
// 路由内手写的 reply.code().send({ error }) 各自测试文件已覆盖，此处只测框架级出口。

const app = testApp();
afterAll(async () => app.close());

test("未知路径 → 404 { error: 'not_found' }", async () => {
  const res = await app.inject({ method: "GET", url: "/definitely-not-a-route" });
  expect(res.statusCode).toBe(404);
  expect(res.json()).toEqual({ error: "not_found" });
});

test("超过 bodyLimit（1MiB）的 JSON → 413 { error: 'payload_too_large' }", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/auth/email/send",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ email: "a".repeat(2 * 1024 * 1024) }),
  });
  expect(res.statusCode).toBe(413);
  expect(res.json()).toEqual({ error: "payload_too_large" });
});

test("路由抛未捕获异常 → 500 { error: 'internal_error' }，不回显内部信息", async () => {
  const boomApp = buildApp({
    databaseUrl: TEST_DB_URL,
    appleJwks,
    s3Bucket: TEST_S3_BUCKET,
    rateLimit: false,
  });
  boomApp.get("/boom", async () => {
    throw new Error("秘密堆栈信息");
  });
  try {
    const res = await boomApp.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: "internal_error" });
    expect(res.body).not.toContain("秘密堆栈");
  } finally {
    await boomApp.close();
  }
});
