import { expect, test } from "vitest";
import { createStorage } from "../src/storage.js";

const storage = createStorage({
  endpoint: "http://localhost:9000",
  publicEndpoint: "http://localhost:9000",
  region: "us-east-1",
  bucket: "zhixing-test",
  accessKey: "zhixing",
  secretKey: "zhixing-secret",
});

test("put → presignGet 能取回内容；remove 后 404", async () => {
  await storage.ensureBucket();
  const key = `test/${Date.now()}.txt`;
  await storage.put(key, Buffer.from("你好知行"), "text/plain");

  const url = await storage.presignGet(key, 60);
  const res = await fetch(url);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("你好知行");

  await storage.remove([key]);
  expect((await fetch(url)).status).toBe(404);
});
