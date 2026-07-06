import cors from "@fastify/cors";
import Fastify from "fastify";
import { createPrisma } from "@zhixing/db";
import { config } from "./config.js";

declare module "fastify" {
  interface FastifyInstance {
    prisma: ReturnType<typeof createPrisma>;
  }
}

export function buildApp(opts: { databaseUrl?: string } = {}) {
  const app = Fastify({ logger: false });
  const prisma = createPrisma(opts.databaseUrl ?? config.databaseUrl);
  app.decorate("prisma", prisma);
  app.register(cors, { origin: true });
  app.get("/health", async () => ({ ok: true }));
  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });
  return app;
}
