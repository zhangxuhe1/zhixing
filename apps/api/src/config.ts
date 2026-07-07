export const config = {
  port: Number(process.env.PORT ?? 8787),
  adminToken: process.env.ADMIN_TOKEN ?? "dev-admin-token",
  databaseUrl:
    process.env.DATABASE_URL ?? "postgresql://zhixing:zhixing@localhost:5433/zhixing",
  sessionSecret: process.env.SESSION_SECRET ?? "dev-session-secret",
  appleBundleId: process.env.APPLE_BUNDLE_ID ?? "app.zhixing.ios",
  devAuth: process.env.ZHIXING_DEV_AUTH === "1",
};
