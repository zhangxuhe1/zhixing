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

test("publicEndpoint ≠ endpoint 时，presignGet 返回的 URL host 取 publicEndpoint（生产走公网域名回归）", async () => {
  const publicStorage = createStorage({
    endpoint: "http://localhost:9000", // 内网地址，服务端用它连 MinIO
    publicEndpoint: "https://cdn.example.com", // 客户端可达的公网地址，presign 必须用它签
    region: "us-east-1",
    bucket: "zhixing-test",
    accessKey: "zhixing",
    secretKey: "zhixing-secret",
  });
  const url = await publicStorage.presignGet("photos/some/key.png", 60);
  expect(new URL(url).host).toBe("cdn.example.com");
  expect(new URL(url).host).not.toBe("localhost:9000");
});
