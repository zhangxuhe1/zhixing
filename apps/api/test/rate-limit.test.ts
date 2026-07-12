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

// 全局限流档位调高，避免与 auth 专属的 10/min 档互相干扰——本用例只关心
// /auth/dev 自己的限流档 + 按 IP 计数是否恒生效。
const authApp = buildApp({
  databaseUrl: TEST_DB_URL,
  appleJwks,
  devAuth: true,
  s3Bucket: "zhixing-test",
  rateLimit: { max: 300 },
});
afterAll(async () => authApp.close());

test("auth 路由恒按 IP 计数：伪造不同 Authorization 头无法绕过 10/min 限制", async () => {
  // 同一 IP（inject 默认 remoteAddress），每次都换一个随机 Authorization 头——
  // 若 keyGenerator 仍是"头优先"，每次都会开一个新桶，永远不会 429。
  let last!: Awaited<ReturnType<typeof authApp.inject>>;
  for (let i = 0; i < 11; i++) {
    last = await authApp.inject({
      method: "POST",
      url: "/auth/dev",
      headers: { authorization: `Bearer junk-${i}-${Math.random()}` },
      payload: { appleSub: `probe-${i}` },
    });
  }
  expect(last.statusCode).toBe(429);
});

// 同上：全局档位调高，避免与 /search 专属的 30/min 档互相干扰——本用例只关心
// /search 自己的限流档 + 按 IP 计数是否恒生效。/search 本身匿名，无需登录态。
const searchApp = buildApp({
  databaseUrl: TEST_DB_URL,
  appleJwks,
  devAuth: true,
  s3Bucket: "zhixing-test",
  rateLimit: { max: 300 },
});
afterAll(async () => searchApp.close());

test("/search 恒按 IP 计数：伪造不同 Authorization 头无法绕过 30/min 限制", async () => {
  // /search 未鉴权，Authorization 头本应完全不影响业务逻辑——这里故意每次换一个随机
  // 假头，若 keyGenerator 仍是"头优先"，每次都会开一个新桶，永远不会 429。
  let last!: Awaited<ReturnType<typeof searchApp.inject>>;
  for (let i = 0; i < 31; i++) {
    last = await searchApp.inject({
      method: "GET",
      url: "/search?q=x",
      headers: { authorization: `Bearer junk-${i}-${Math.random()}` },
    });
  }
  expect(last.statusCode).toBe(429);
});

// 同上：全局档位调高，只测 /auth/email/send 自己的 10/min 档 + 按 IP 计数是否恒生效（S5）。
const emailApp = buildApp({
  databaseUrl: TEST_DB_URL,
  appleJwks,
  devAuth: true,
  s3Bucket: "zhixing-test",
  rateLimit: { max: 300 },
});
afterAll(async () => emailApp.close());

test("/auth/email/send 恒按 IP 计数：伪造不同 Authorization 头无法绕过 10/min 限制", async () => {
  // 每次都换一个全新邮箱（时间戳保证跨次运行也不复用，避开同邮箱 60s 冷却/日限干扰）
  // + 随机假 Authorization 头——前 10 次应 200，第 11 次唯一可能的拦截者只剩 per-IP 桶；
  // 若 keyGenerator 仍是"头优先"，每次都会开一个新桶，永远不会 429。
  const run = Date.now();
  let last!: Awaited<ReturnType<typeof emailApp.inject>>;
  for (let i = 0; i < 11; i++) {
    last = await emailApp.inject({
      method: "POST",
      url: "/auth/email/send",
      headers: { authorization: `Bearer junk-${i}-${Math.random()}` },
      payload: { email: `probe-${run}-${i}@rl.test` },
    });
    if (i < 10) expect(last.statusCode).toBe(200);
  }
  expect(last.statusCode).toBe(429);
});
