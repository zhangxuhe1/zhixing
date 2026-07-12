import { expect, test } from "vitest";
import { findWeakSecrets } from "../src/prodGuard.js";

// 纯函数测试：不连库、不 buildApp——启动断言的判定逻辑本身与 Fastify 无关。
const strong = {
  SESSION_SECRET: "3f9c2a71d8e4b6051c9f7a2e8d3b4c6a",
  ADMIN_TOKEN: "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  S3_SECRET_KEY: "0f1e2d3c4b5a69788796a5b4c3d2e1f0",
};

test("三值均为强随机串 → 空数组（放行）", () => {
  expect(findWeakSecrets(strong)).toEqual([]);
});

test("SESSION_SECRET 为 dev 默认值 → 拦下", () => {
  expect(findWeakSecrets({ ...strong, SESSION_SECRET: "dev-session-secret" })).toEqual([
    "SESSION_SECRET",
  ]);
});

test("ADMIN_TOKEN 为 change-me 占位值 → 拦下", () => {
  expect(findWeakSecrets({ ...strong, ADMIN_TOKEN: "change-me" })).toEqual(["ADMIN_TOKEN"]);
});

test("S3_SECRET_KEY 为空串（compose 缺变量替换产物）→ 拦下", () => {
  expect(findWeakSecrets({ ...strong, S3_SECRET_KEY: "" })).toEqual(["S3_SECRET_KEY"]);
});

test("S3_SECRET_KEY 为 dev 默认值 zhixing-secret → 拦下", () => {
  expect(findWeakSecrets({ ...strong, S3_SECRET_KEY: "zhixing-secret" })).toEqual([
    "S3_SECRET_KEY",
  ]);
});

test("纯空白串也算空串 → 拦下", () => {
  expect(findWeakSecrets({ ...strong, ADMIN_TOKEN: "  " })).toEqual(["ADMIN_TOKEN"]);
});

test("多项同时弱 → 按键序全部列出", () => {
  expect(
    findWeakSecrets({
      SESSION_SECRET: "dev-session-secret",
      ADMIN_TOKEN: "dev-admin-token",
      S3_SECRET_KEY: "change-me",
    }),
  ).toEqual(["SESSION_SECRET", "ADMIN_TOKEN", "S3_SECRET_KEY"]);
});
