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

/** 公开端点用：有合法 Bearer 则填 req.userId，缺失/无效均放行（不 401）。 */
export async function optionalUser(req: FastifyRequest) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return;
  try {
    req.userId = await verifySession(header.slice(7));
  } catch {
    // 忽略无效 token，按匿名处理
  }
}
