import "./env.js";
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { findWeakSecrets } from "./prodGuard.js";

// 生产启动断言：弱密钥（空串/默认值/占位值）拒绝启动，防止带上生产（deploy.md 硬化清单第 1 项）。
// NODE_ENV=production 由 compose.prod.yml 注入；本地 dev 不设该值，dev 默认值照常可用。
if (process.env.NODE_ENV === "production") {
  const weak = findWeakSecrets({
    SESSION_SECRET: config.sessionSecret,
    ADMIN_TOKEN: config.adminToken,
    S3_SECRET_KEY: config.s3.secretKey,
  });
  if (weak.length > 0) {
    console.error(
      `拒绝启动：以下密钥为空串/默认值/占位值，请在 .env.production 设为强随机值（openssl rand -hex 24）：${weak.join(", ")}`,
    );
    process.exit(1);
  }
}

const app = buildApp({ logger: true, trustProxy: config.trustProxy });
app.listen({ port: config.port, host: "0.0.0.0" }).then(() => {
  console.log(`zhixing api listening on :${config.port}`);
});
