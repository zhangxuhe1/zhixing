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
