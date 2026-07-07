import cors from "@fastify/cors";
import Fastify from "fastify";
import { createPrisma } from "@zhixing/db";
import { remoteAppleJwks, type AppleJwks } from "./apple.js";
import { config } from "./config.js";
import { authRoutes } from "./routes/auth.js";
import { cardsRoutes } from "./routes/cards.js";
import { placesRoutes } from "./routes/places.js";

declare module "fastify" {
  interface FastifyInstance {
    prisma: ReturnType<typeof createPrisma>;
    appleJwks: AppleJwks;
    devAuth: boolean;
  }
}

export interface BuildAppOpts {
  databaseUrl?: string;
  appleJwks?: AppleJwks;
  devAuth?: boolean;
}

export function buildApp(opts: BuildAppOpts = {}) {
  const app = Fastify({ logger: false });
  const prisma = createPrisma(opts.databaseUrl ?? config.databaseUrl);
  app.decorate("prisma", prisma);
  app.decorate("appleJwks", opts.appleJwks ?? remoteAppleJwks());
  app.decorate("devAuth", opts.devAuth ?? config.devAuth);
  app.register(cors, { origin: true });
  app.get("/health", async () => ({ ok: true }));
  app.register(placesRoutes);
  app.register(cardsRoutes);
  app.register(authRoutes);
  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });
  return app;
}
