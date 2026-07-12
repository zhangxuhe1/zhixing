import { randomInt } from "node:crypto";
import type { PrismaClient } from "@zhixing/db";
import { renderCodeEmail, sendMail } from "./mailer.js";

/**
 * 邮箱验证码登录的三重加固常量。全部行为参数收敛在此，路由/服务层禁止再散落魔法数。
 * - length：验证码位数（补零到 6 位数字串）
 * - ttlMs：有效期 10min（落库 expiresAt = now + ttlMs）
 * - cooldownMs：同邮箱两次发码最小间隔 60s（冷却）
 * - dailyMax：同邮箱滚动 24h 窗口内发码上限 10 次（日限）
 * - maxAttempts：同一验证码最多错试 5 次，到顶即锁死（爆破防护）
 */
export const EMAIL_CODE = {
  length: 6,
  ttlMs: 10 * 60_000,
  cooldownMs: 60_000,
  dailyMax: 10, // 滚动 24h 窗口
  maxAttempts: 5,
} as const;

/** 冷却与日限统一抛它——路由层捕获后一律映射为 429 rate_limited，不区分是哪一道闸拦下。 */
export class EmailCooldownError extends Error {}

/**
 * 邮箱规范化唯一入口：trim + 转小写。
 * send / verify 两个端点入口与身份 subject 三处必须共用此函数，禁止各自手写，
 * 否则大小写/空白差异会造成"看似同一邮箱却建出两个账号"。
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** 生成一枚 6 位、前导补零的数字验证码（0~999999 均匀取样）。 */
function generateCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(EMAIL_CODE.length, "0");
}

/**
 * 签发一枚邮箱验证码。调用前 email 必须已 normalizeEmail。
 *
 * 双闸顺序（先冷却、后日限）：
 * 1. 冷却：该邮箱最新一条记录距今 < cooldownMs → 抛 EmailCooldownError；
 * 2. 日限：该邮箱滚动 24h 内记录数 ≥ dailyMax → 抛 EmailCooldownError。
 * 两闸皆过后落库（expiresAt = now + ttlMs）并发信。发信副作用受 config.smtp.url 控制：
 * 未配置（dev/test）时 sendMail 仅控制台打印，绝无网络副作用。
 */
export async function issueEmailCode(prisma: PrismaClient, email: string): Promise<void> {
  const now = Date.now();

  const latest = await prisma.emailCode.findFirst({
    where: { email },
    orderBy: { createdAt: "desc" },
  });
  if (latest && now - latest.createdAt.getTime() < EMAIL_CODE.cooldownMs) {
    throw new EmailCooldownError("cooldown");
  }

  const dailyCount = await prisma.emailCode.count({
    where: { email, createdAt: { gte: new Date(now - 24 * 60 * 60_000) } },
  });
  if (dailyCount >= EMAIL_CODE.dailyMax) {
    throw new EmailCooldownError("daily_limit");
  }

  const code = generateCode();
  await prisma.emailCode.create({
    data: { email, code, expiresAt: new Date(now + EMAIL_CODE.ttlMs) },
  });
  const mail = renderCodeEmail(code);
  await sendMail(email, mail.subject, mail.text, mail.html);
}

/**
 * 校验邮箱验证码。调用前 email 必须已 normalizeEmail。
 *
 * 判定顺序（顺序即安全语义，勿调整）：
 * 1. 取该邮箱**最新一条未过期**记录（expiresAt > now，按 createdAt 倒序）；旧码/过期码隐式作废；
 * 2. 无记录 → false；
 * 3. attempts ≥ maxAttempts → false（**先于比码**：锁死后即便递交正确码也救不回，且不再自增）；
 * 4. 码不等 → attempts 自增后 false；
 * 5. 码相等 → deleteMany 该邮箱全部码（单次使用，杜绝重放）后 true。
 *
 * 返回值只有 true/false——"错/过期/超试"对调用方不可区分，不给攻击者反馈面。
 */
export async function verifyEmailCode(
  prisma: PrismaClient,
  email: string,
  code: string,
): Promise<boolean> {
  const record = await prisma.emailCode.findFirst({
    where: { email, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!record) return false;
  if (record.attempts >= EMAIL_CODE.maxAttempts) return false;
  if (record.code !== code) {
    await prisma.emailCode.update({
      where: { id: record.id },
      data: { attempts: { increment: 1 } },
    });
    return false;
  }
  await prisma.emailCode.deleteMany({ where: { email } });
  return true;
}
