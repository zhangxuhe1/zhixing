export const config = {
  port: Number(process.env.PORT ?? 8787),
  adminToken: process.env.ADMIN_TOKEN ?? "dev-admin-token",
  databaseUrl:
    process.env.DATABASE_URL ?? "postgresql://zhixing:zhixing@localhost:5433/zhixing",
  sessionSecret: process.env.SESSION_SECRET ?? "dev-session-secret",
  appleBundleId: process.env.APPLE_BUNDLE_ID ?? "app.zhixing.ios",
  devAuth: process.env.ZHIXING_DEV_AUTH === "1",
  shareLandingUrl: process.env.SHARE_LANDING_URL ?? "http://localhost:8787/beta",
  s3: {
    endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
    publicEndpoint: process.env.S3_PUBLIC_ENDPOINT ?? process.env.S3_ENDPOINT ?? "http://localhost:9000",
    region: process.env.S3_REGION ?? "us-east-1",
    bucket: process.env.S3_BUCKET ?? "zhixing",
    accessKey: process.env.S3_ACCESS_KEY ?? "zhixing",
    secretKey: process.env.S3_SECRET_KEY ?? "zhixing-secret",
  },
};
