import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { verifyAppleIdentityToken } from "../apple.js";
import { requireUser } from "../auth.js";
import { config } from "../config.js";
import { signSession } from "../session.js";

const appleSchema = z.object({ identityToken: z.string().min(10), nickname: z.string().min(1).max(20).optional() });
const devSchema = z.object({ appleSub: z.string().min(1), nickname: z.string().min(1).max(20).optional() });

async function loginBySub(app: FastifyInstance, appleSub: string, nickname?: string) {
  const user = await app.prisma.user.upsert({
    where: { appleSub },
    update: nickname ? { nickname } : {},
    create: { appleSub, nickname: nickname ?? `旅人${appleSub.slice(-4)}` },
  });
  return { token: await signSession(user.id), user: { id: user.id, nickname: user.nickname } };
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
    return loginBySub(app, sub, body.data.nickname);
  });

  if (app.devAuth) {
    app.post("/auth/dev", { config: authRateLimit }, async (req, reply) => {
      const body = devSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: "invalid_body" });
      return loginBySub(app, body.data.appleSub, body.data.nickname);
    });
  }

  app.get("/me", { preHandler: requireUser }, async (req, reply) => {
    const user = await app.prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    return { id: user.id, nickname: user.nickname };
  });
}
