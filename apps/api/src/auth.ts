import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  if (req.headers.authorization !== `Bearer ${config.adminToken}`) {
    return reply.code(401).send({ error: "unauthorized" });
  }
}
