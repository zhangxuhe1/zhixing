export const config = {
  port: Number(process.env.PORT ?? 8787),
  adminToken: process.env.ADMIN_TOKEN ?? "dev-admin-token",
  databaseUrl:
    process.env.DATABASE_URL ?? "postgresql://zhixing:zhixing@localhost:5432/zhixing",
};
