import { afterAll, expect, test } from "vitest";
import { testApp } from "./helpers.js";

const app = testApp();
afterAll(async () => app.close());

test("GET /health 返回 ok", async () => {
  const res = await app.inject({ method: "GET", url: "/health" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
});
