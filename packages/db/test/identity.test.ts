import { afterAll, beforeEach, expect, test } from "vitest";
import { createPrisma } from "../src/index.js";

const prisma = createPrisma(
  process.env.TEST_DATABASE_URL ?? "postgresql://zhixing:zhixing@localhost:5433/zhixing_test",
);

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "Like","CardFavorite","CardReport","FootprintPhoto","Footprint","Trip","CardBlock","Card","PlaceLink","Place","User","Identity","EmailCode","SearchMiss" RESTART IDENTITY CASCADE',
  );
});
afterAll(async () => prisma.$disconnect());

function uniqueSub() {
  return `sub-${Math.random()}`;
}

function uniqueEmail() {
  return `code-${Math.random()}@example.com`;
}

test("建 User 时嵌套建 APPLE Identity，按 (provider, subject) 复合唯一键查回", async () => {
  const sub = uniqueSub();
  const user = await prisma.user.create({
    data: {
      nickname: "阿彪",
      identities: { create: { provider: "APPLE", subject: sub } },
    },
  });

  const identity = await prisma.identity.findUniqueOrThrow({
    where: { provider_subject: { provider: "APPLE", subject: sub } },
  });
  expect(identity.userId).toBe(user.id);
});

test("同一 (provider, subject) 二次插入触发唯一约束错误 P2002", async () => {
  const sub = uniqueSub();
  const user = await prisma.user.create({ data: { nickname: "阿彪" } });
  await prisma.identity.create({ data: { userId: user.id, provider: "APPLE", subject: sub } });

  await expect(
    prisma.identity.create({ data: { userId: user.id, provider: "APPLE", subject: sub } }),
  ).rejects.toMatchObject({ code: "P2002" });
});

test("删除 User 级联删除其 Identity", async () => {
  const sub = uniqueSub();
  const user = await prisma.user.create({
    data: {
      nickname: "阿彪",
      identities: { create: { provider: "APPLE", subject: sub } },
    },
  });
  const identity = await prisma.identity.findUniqueOrThrow({
    where: { provider_subject: { provider: "APPLE", subject: sub } },
  });

  await prisma.user.delete({ where: { id: user.id } });

  expect(await prisma.identity.findUnique({ where: { id: identity.id } })).toBeNull();
});

test("同一 User 可同时挂 APPLE 与 EMAIL 两条身份", async () => {
  const sub = uniqueSub();
  const email = "user@example.com";
  const user = await prisma.user.create({
    data: {
      nickname: "阿彪",
      identities: {
        create: [
          { provider: "APPLE", subject: sub },
          { provider: "EMAIL", subject: email },
        ],
      },
    },
  });

  const identities = await prisma.identity.findMany({
    where: { userId: user.id },
    orderBy: { provider: "asc" },
  });
  expect(identities.map((i) => i.provider)).toEqual(["APPLE", "EMAIL"]);
  expect(identities.map((i) => i.subject)).toEqual([sub, email]);
});

test("EmailCode 建行、按 email 查回、attempts 默认 0", async () => {
  const email = uniqueEmail();
  await prisma.emailCode.create({
    data: { email, code: "123456", expiresAt: new Date(Date.now() + 10 * 60_000) },
  });

  const rows = await prisma.emailCode.findMany({ where: { email } });
  expect(rows).toHaveLength(1);
  expect(rows[0].code).toBe("123456");
  expect(rows[0].attempts).toBe(0);
});
