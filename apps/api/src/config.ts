export const config = {
  port: Number(process.env.PORT ?? 8787),
  adminToken: process.env.ADMIN_TOKEN ?? "dev-admin-token",
  databaseUrl:
    process.env.DATABASE_URL ?? "postgresql://zhixing:zhixing@localhost:5433/zhixing",
  sessionSecret: process.env.SESSION_SECRET ?? "dev-session-secret",
  appleBundleId: process.env.APPLE_BUNDLE_ID ?? "app.zhixing.ios",
  devAuth: process.env.ZHIXING_DEV_AUTH === "1",
  shareLandingUrl: process.env.SHARE_LANDING_URL ?? "http://localhost:8787/beta",
  // 反向代理（Nginx/负载均衡）后面部署时开启，Fastify 才会信任 X-Forwarded-* 头
  // 解析出真实客户端 IP（req.ip）——直连部署下必须保持默认关闭，否则客户端可
  // 伪造该头绕过按 IP 计数的限流。
  trustProxy: process.env.TRUST_PROXY === "1",
  s3: {
    endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
    publicEndpoint: process.env.S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT ?? "http://localhost:9000",
    region: process.env.S3_REGION ?? "us-east-1",
    bucket: process.env.S3_BUCKET ?? "zhixing",
    accessKey: process.env.S3_ACCESS_KEY ?? "zhixing",
    secretKey: process.env.S3_SECRET_KEY ?? "zhixing-secret",
  },
  smtp: {
    // 空字符串 = dev/test 默认：sendMail 走控制台打印分支，绝无网络副作用
    url: process.env.SMTP_URL ?? "",
    from: process.env.MAIL_FROM ?? "知行 <noreply@example.com>",
  },
};
