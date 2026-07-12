import { afterAll, beforeEach, expect, test } from "vitest";
import { EMAIL_CODE } from "../src/emailAuth.js";
import { resetDb, testApp } from "./helpers.js";

// 邮箱验证码登录（S5）：真实测试库直查 EmailCode 取码，绝不 mock；
// SMTP_URL 未配置（test 默认）时 sendMail 仅控制台打印，无网络副作用。
const app = testApp();
beforeEach(() => resetDb(app));
afterAll(async () => app.close());

const EMAIL = "foo@test.dev";

function send(email: string) {
  return app.inject({ method: "POST", url: "/auth/email/send", payload: { email } });
}

function verify(email: string, code: string) {
  return app.inject({ method: "POST", url: "/auth/email/verify", payload: { email, code } });
}

/** 直查测试库取该邮箱最新一条验证码记录（码只能从表里拿，邮件不真发） */
function latestRecord(email = EMAIL) {
  return app.prisma.emailCode.findFirst({ where: { email }, orderBy: { createdAt: "desc" } });
}

/** 构造一个与真码必不相等的 6 位数字错码 */
function wrongCode(code: string) {
  return String((Number(code) + 1) % 1_000_000).padStart(6, "0");
}

test("用例1 发码成功与规范化：email 先 trim+小写落库，码为 6 位数字，expiresAt≈now+10min", async () => {
  const before = Date.now();
  const res = await send(" Foo@Test.Dev ");
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });

  const rows = await app.prisma.emailCode.findMany();
  expect(rows).toHaveLength(1);
  expect(rows[0].email).toBe("foo@test.dev");
  expect(rows[0].code).toMatch(/^\d{6}$/);
  // expiresAt ≈ now + 10min，±15s 容差（避免执行耗时导致的毫秒级误差误判）
  expect(Math.abs(rows[0].expiresAt.getTime() - (before + 10 * 60_000))).toBeLessThan(15_000);
});

test("用例2 登录闭环：send → 表取码 → verify 得 token/user → /me 200；User+Identity 各一行，EmailCode 清空", async () => {
  expect((await send(EMAIL)).statusCode).toBe(200);
  const record = await latestRecord();
  const res = await verify(EMAIL, record!.code);
  expect(res.statusCode).toBe(200);
  const { token, user } = res.json();
  expect(token).toBeTruthy();
  expect(user.id).toBeTruthy();
  expect(user.nickname).toBeTruthy();

  const me = await app.inject({
    method: "GET", url: "/me", headers: { authorization: `Bearer ${token}` },
  });
  expect(me.statusCode).toBe(200);
  expect(me.json().id).toBe(user.id);

  expect(await app.prisma.user.count()).toBe(1);
  const identities = await app.prisma.identity.findMany({
    where: { provider: "EMAIL", subject: EMAIL },
  });
  expect(identities).toHaveLength(1);
  expect(identities[0].userId).toBe(user.id);
  // 登录成功即清空该邮箱全部码（单次使用）
  expect(await app.prisma.emailCode.count({ where: { email: EMAIL } })).toBe(0);
});

test("用例3 单次使用：同码二次 verify → 401 invalid_code", async () => {
  await send(EMAIL);
  const record = await latestRecord();
  expect((await verify(EMAIL, record!.code)).statusCode).toBe(200);

  const again = await verify(EMAIL, record!.code);
  expect(again.statusCode).toBe(401);
  expect(again.json().error).toBe("invalid_code");
});

test("用例4 复登录归一账号：换大小写 FOO@test.dev 再走 send+verify → 同一 user.id，账号不翻倍", async () => {
  await send(EMAIL);
  const first = await verify(EMAIL, (await latestRecord())!.code);
  expect(first.statusCode).toBe(200);

  // 首登成功已清空 EmailCode，二次 send 不受冷却影响
  expect((await send("FOO@test.dev")).statusCode).toBe(200);
  const second = await verify("FOO@test.dev", (await latestRecord())!.code);
  expect(second.statusCode).toBe(200);
  expect(second.json().user.id).toBe(first.json().user.id);
  expect(await app.prisma.user.count()).toBe(1);
});

test("用例5 默认昵称：首登 nickname == 邮箱本地部分（@ 前，截前 20 字）", async () => {
  await send(EMAIL);
  const res = await verify(EMAIL, (await latestRecord())!.code);
  expect(res.json().user.nickname).toBe("foo");
  const user = await app.prisma.user.findUnique({ where: { id: res.json().user.id } });
  expect(user!.nickname).toBe("foo");

  // 本地部分超 20 字时截前 20 字（昵称约束 1–20 字）
  const long = "abcdefghijklmnopqrstuvwxyz@test.dev";
  await send(long);
  const longRes = await verify(long, (await latestRecord(long))!.code);
  expect(longRes.statusCode).toBe(200);
  expect(longRes.json().user.nickname).toBe("abcdefghijklmnopqrst");
});

test("用例6 错码计数：verify 错码一次 → 401，该记录 attempts == 1", async () => {
  await send(EMAIL);
  const record = await latestRecord();
  const res = await verify(EMAIL, wrongCode(record!.code));
  expect(res.statusCode).toBe(401);
  expect(res.json().error).toBe("invalid_code");

  const after = await app.prisma.emailCode.findUnique({ where: { id: record!.id } });
  expect(after!.attempts).toBe(1);
});

test("用例7 爆破锁死：错码 5 次后用正确码 verify 仍 401（attempts 到顶，码已废）", async () => {
  await send(EMAIL);
  const record = await latestRecord();
  const bad = wrongCode(record!.code);
  for (let i = 0; i < 5; i++) {
    expect((await verify(EMAIL, bad)).statusCode).toBe(401);
  }

  const res = await verify(EMAIL, record!.code); // 正确码也救不回来
  expect(res.statusCode).toBe(401);
  expect(res.json().error).toBe("invalid_code");
  // 锁死判定先于比码：正确码那次不再自增 attempts
  const after = await app.prisma.emailCode.findUnique({ where: { id: record!.id } });
  expect(after!.attempts).toBe(5);
});

test("用例8 60s 冷却：连发第二次 429 rate_limited；首条 createdAt 回拨 61s 后再发 → 200", async () => {
  expect((await send(EMAIL)).statusCode).toBe(200);

  const second = await send(EMAIL);
  expect(second.statusCode).toBe(429);
  expect(second.json().error).toBe("rate_limited");
  expect(await app.prisma.emailCode.count({ where: { email: EMAIL } })).toBe(1);

  // 回拨到冷却线外（61s > 60s），恢复可发
  await app.prisma.emailCode.updateMany({
    where: { email: EMAIL },
    data: { createdAt: new Date(Date.now() - 61_000) },
  });
  expect((await send(EMAIL)).statusCode).toBe(200);
  expect(await app.prisma.emailCode.count({ where: { email: EMAIL } })).toBe(2);
});

test("用例9 24h 日限：近 24h 已有 10 条记录（均在冷却线外）→ send 429 rate_limited", async () => {
  // 直插 10 行：createdAt 分散于近 24h（1h..10h 前），都早于 60s 冷却线
  await app.prisma.emailCode.createMany({
    data: Array.from({ length: 10 }, (_, i) => ({
      email: EMAIL,
      code: String(i).repeat(6),
      expiresAt: new Date(Date.now() + 10 * 60_000),
      createdAt: new Date(Date.now() - (i + 1) * 60 * 60_000),
    })),
  });

  const res = await send(EMAIL);
  expect(res.statusCode).toBe(429);
  expect(res.json().error).toBe("rate_limited");
  // 被日限拦下：未新增记录
  expect(await app.prisma.emailCode.count({ where: { email: EMAIL } })).toBe(10);
});

test("用例10 过期码：expiresAt 回拨 1s 后用正确码 verify → 401", async () => {
  await send(EMAIL);
  const record = await latestRecord();
  await app.prisma.emailCode.update({
    where: { id: record!.id },
    data: { expiresAt: new Date(Date.now() - 1_000) },
  });

  const res = await verify(EMAIL, record!.code);
  expect(res.statusCode).toBe(401);
  expect(res.json().error).toBe("invalid_code");
});

test("用例11 参数校验：非法邮箱 / code 长度非 6 或非数字 → 400 invalid_body", async () => {
  for (const bad of ["not-an-email", "a@", "@b.c", ""]) {
    const res = await send(bad);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  }
  // 缺字段
  const missing = await app.inject({ method: "POST", url: "/auth/email/send", payload: {} });
  expect(missing.statusCode).toBe(400);
  expect(missing.json().error).toBe("invalid_body");

  // verify：邮箱非法
  const badMail = await verify("not-an-email", "123456");
  expect(badMail.statusCode).toBe(400);
  expect(badMail.json().error).toBe("invalid_body");
  // verify：code 长度非 6 / 非数字
  for (const code of ["12345", "1234567", "abcdef", ""]) {
    const res = await verify(EMAIL, code);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  }
});

test("用例12 并发爆破硬上限：同码 20 个并发错码 verify → 全部 401，attempts 恰好停在 maxAttempts（读改比码不会被并发击穿）", async () => {
  await send(EMAIL);
  const record = await latestRecord();
  const bad = wrongCode(record!.code);

  const results = await Promise.all(
    Array.from({ length: 20 }, () => verify(EMAIL, bad)),
  );
  for (const res of results) {
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_code");
  }

  const after = await app.prisma.emailCode.findUnique({ where: { id: record!.id } });
  expect(after!.attempts).toBe(EMAIL_CODE.maxAttempts);
});
