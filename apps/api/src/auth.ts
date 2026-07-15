import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import { verifySession } from "./session.js";

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  if (req.headers.authorization !== `Bearer ${config.adminToken}`) {
    return reply.code(401).send({ error: "unauthorized" });
  }
}

declare module "fastify" {
  interface FastifyRequest {
    userId: string;
  }
}

export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  try {
    req.userId = await verifySession(header.slice(7));
  } catch {
    return reply.code(401).send({ error: "unauthorized" });
  }
}

declare module "fastify" {
  interface FastifyRequest {
    /** optionalUser 解析结果:未带/非法 Bearer 时为 null,绝不 401 */
    optionalUserId: string | null;
  }
}

/**
 * 可选登录:匿名照常放行,带合法 Bearer 则识别身份。
 * 用于"匿名可读、登录后额外可见自己私有数据"的读面(pins/搜索/地点详情)。
 */
export async function optionalUser(req: FastifyRequest) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    req.optionalUserId = null;
    return;
  }
  try {
    req.optionalUserId = await verifySession(header.slice(7));
  } catch {
    req.optionalUserId = null;
  }
}
