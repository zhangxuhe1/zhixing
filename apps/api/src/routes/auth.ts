import type { FastifyInstance, FastifyRequest } from "fastify";
import { Prisma, type IdentityProvider } from "@zhixing/db";
import { z } from "zod";
import { verifyAppleIdentityToken } from "../apple.js";
import { requireUser } from "../auth.js";
import { config } from "../config.js";
import { signSession } from "../session.js";

const appleSchema = z.object({ identityToken: z.string().min(10), nickname: z.string().min(1).max(20).optional() });
const devSchema = z.object({ appleSub: z.string().min(1), nickname: z.string().min(1).max(20).optional() });

/** 缺省昵称：APPLE = 旅人 + subject 后 4 位（与迁移前逐字节一致，保 seed/dev 既有数据兼容）；
 *  EMAIL = 邮箱本地部分（@ 前）截前 20 字（昵称约束 1–20 字，S5 邮箱登录复用）。 */
function defaultNickname(provider: IdentityProvider, subject: string): string {
  return provider === "EMAIL" ? subject.split("@")[0].slice(0, 20) : `旅人${subject.slice(-4)}`;
}

/**
 * 按 (provider, subject) 身份登录：查 Identity（provider_subject 复合唯一）带出 user——
 * 命中且传了 nickname 则更新昵称，否则原样返回；未命中则单次 user.create 嵌套 identities.create
 * 同时建 User 与 Identity。并发兜底：两个首登请求竞态撞 P2002 → 重查一次 Identity 后按命中路径
 * 返回，绝不向上抛。S5 的邮箱登录（provider=EMAIL）复用此函数。
 */
async function loginByIdentity(
  app: FastifyInstance,
  provider: IdentityProvider,
  subject: string,
  nickname?: string,
): Promise<{ token: string; user: { id: string; nickname: string } }> {
  const respond = async (current: { id: string; nickname: string }) => {
    const user = nickname
      ? await app.prisma.user.update({ where: { id: current.id }, data: { nickname } })
      : current;
    return { token: await signSession(user.id), user: { id: user.id, nickname: user.nickname } };
  };

  const existing = await app.prisma.identity.findUnique({
    where: { provider_subject: { provider, subject } },
    select: { user: { select: { id: true, nickname: true } } },
  });
  if (existing) return respond(existing.user);

  try {
    const user = await app.prisma.user.create({
      data: {
        nickname: nickname ?? defaultNickname(provider, subject),
        identities: { create: { provider, subject } },
      },
    });
    return { token: await signSession(user.id), user: { id: user.id, nickname: user.nickname } };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const raced = await app.prisma.identity.findUnique({
        where: { provider_subject: { provider, subject } },
        select: { user: { select: { id: true, nickname: true } } },
      });
      if (raced) return respond(raced.user);
    }
    throw err;
  }
}

// auth 路由恒按 IP 计数：全局 keyGenerator 在有 Authorization 头时按头计费，
// 攻击者可给每次请求都塞一个随机 Bearer 头骗出新桶，绕开限流做凭证/token 爆破。
// 这里显式覆盖为按 req.ip 计数，与是否携带、携带什么头无关。
const authRateLimit = {
  rateLimit: { max: 10, timeWindow: "1 minute", keyGenerator: (req: FastifyRequest) => req.ip },
};

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/apple", { config: authRateLimit }, async (req, reply) => {
    const body = appleSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });
    let sub: string;
    try {
      ({ sub } = await verifyAppleIdentityToken(
        body.data.identityToken, app.appleJwks, config.appleBundleId,
      ));
    } catch {
      return reply.code(401).send({ error: "invalid_apple_token" });
    }
    return loginByIdentity(app, "APPLE", sub, body.data.nickname);
  });

  if (app.devAuth) {
    app.post("/auth/dev", { config: authRateLimit }, async (req, reply) => {
      const body = devSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "invalid_body" });
      return loginByIdentity(app, "APPLE", body.data.appleSub, body.data.nickname);
    });
  }

  app.get("/me", { preHandler: requireUser }, async (req, reply) => {
    const user = await app.prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    return { id: user.id, nickname: user.nickname };
  });
}
