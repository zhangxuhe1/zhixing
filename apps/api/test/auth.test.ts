import { afterAll, beforeEach, expect, test } from "vitest";
import { buildApp } from "../src/app.js";
import { appleJwks, fakeAppleToken, resetDb, testApp, TEST_DB_URL, TEST_S3_BUCKET } from "./helpers.js";

const app = testApp();
beforeEach(() => resetDb(app));
afterAll(async () => app.close());

test("apple 登录：首次创建用户，二次登录复用", async () => {
  const token = await fakeAppleToken("apple-sub-9");
  const first = await app.inject({
    method: "POST", url: "/auth/apple",
    payload: { identityToken: token, nickname: "老张" },
  });
  expect(first.statusCode).toBe(200);
  expect(first.json().user.nickname).toBe("老张");

  const second = await app.inject({
    method: "POST", url: "/auth/apple", payload: { identityToken: token },
  });
  expect(second.json().user.id).toBe(first.json().user.id);
  expect(await app.prisma.user.count()).toBe(1);

  const renamed = await app.inject({
    method: "POST", url: "/auth/apple",
    payload: { identityToken: token, nickname: "老张二号" },
  });
  expect(renamed.json().user.nickname).toBe("老张二号");
  expect(await app.prisma.user.count()).toBe(1);
});

test("audience 不匹配的 identityToken 被拒", async () => {
  const bad = await fakeAppleToken("apple-sub-9", "com.evil.app");
  const res = await app.inject({ method: "POST", url: "/auth/apple", payload: { identityToken: bad } });
  expect(res.statusCode).toBe(401);
});

test("会话 token 能访问 /me；无 token 401", async () => {
  const token = await fakeAppleToken("apple-sub-9");
  const login = await app.inject({ method: "POST", url: "/auth/apple", payload: { identityToken: token } });
  const me = await app.inject({
    method: "GET", url: "/me",
    headers: { authorization: `Bearer ${login.json().token}` },
  });
  expect(me.statusCode).toBe(200);
  expect(me.json().nickname).toMatch(/^旅人/);
  expect((await app.inject({ method: "GET", url: "/me" })).statusCode).toBe(401);
});

test("devAuth 关闭时 /auth/dev 不存在", async () => {
  // s3Bucket 须显式传：devAuth-off 场景若漏传会落到生产默认桶名，onReady 触发
  // ensureBucket() 时误在本地 MinIO 建一个非测试桶（副作用，与本用例无关）。
  const closed = buildApp({ databaseUrl: TEST_DB_URL, appleJwks, devAuth: false, s3Bucket: TEST_S3_BUCKET });
  const res = await closed.inject({ method: "POST", url: "/auth/dev", payload: { appleSub: "x" } });
  expect(res.statusCode).toBe(404);
  await closed.close();
});
