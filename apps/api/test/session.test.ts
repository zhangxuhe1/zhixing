import { expect, test } from "vitest";
import { signSession, verifySession } from "../src/session.js";

test("签发的会话能验回 userId", async () => {
  const token = await signSession("user-1");
  expect(await verifySession(token)).toBe("user-1");
});

test("篡改的 token 验签失败", async () => {
  const token = await signSession("user-1");
  await expect(verifySession(token.slice(0, -2) + "xx")).rejects.toThrow();
});
