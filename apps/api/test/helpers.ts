import { buildApp } from "../src/app.js";

export const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://zhixing:zhixing@localhost:5432/zhixing_test";

export function testApp() {
  return buildApp({ databaseUrl: TEST_DB_URL });
}

export async function resetDb(app: ReturnType<typeof buildApp>) {
  await app.prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "FootprintPhoto","Footprint","CardBlock","Card","Place","User","SearchMiss" RESTART IDENTITY CASCADE',
  );
}

export const ADMIN_AUTH = { authorization: "Bearer dev-admin-token" };
