import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { createPrisma } from "@zhixing/db";
import { remoteAppleJwks, type AppleJwks } from "./apple.js";
import { config } from "./config.js";
import { authRoutes } from "./routes/auth.js";
import { cardsRoutes } from "./routes/cards.js";
import { footprintsRoutes } from "./routes/footprints.js";
import { photosRoutes } from "./routes/photos.js";
import { placesRoutes } from "./routes/places.js";
import { publicRoutes } from "./routes/public.js";
import { searchRoutes } from "./routes/search.js";
import { createStorage, type Storage } from "./storage.js";

declare module "fastify" {
  interface FastifyInstance {
    prisma: ReturnType<typeof createPrisma>;
    appleJwks: AppleJwks;
    devAuth: boolean;
    storage: Storage;
  }
}

export interface BuildAppOpts {
  databaseUrl?: string;
  appleJwks?: AppleJwks;
  devAuth?: boolean;
  s3Bucket?: string;
  logger?: boolean;
}

export function buildApp(opts: BuildAppOpts = {}) {
  const app = Fastify({ logger: opts.logger ?? false });
  const prisma = createPrisma(opts.databaseUrl ?? config.databaseUrl);
  app.decorate("prisma", prisma);
  app.decorate("appleJwks", opts.appleJwks ?? remoteAppleJwks());
  app.decorate("devAuth", opts.devAuth ?? config.devAuth);
  const storage = createStorage({ ...config.s3, bucket: opts.s3Bucket ?? config.s3.bucket });
  app.decorate("storage", storage);
  app.addHook("onReady", async () => {
    await storage.ensureBucket();
  });
  app.register(cors, { origin: true });
  app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024, files: 1 } });
  app.get("/health", async () => ({ ok: true }));
  app.register(placesRoutes);
  app.register(cardsRoutes);
  app.register(authRoutes);
  app.register(footprintsRoutes);
  app.register(photosRoutes);
  app.register(publicRoutes);
  app.register(searchRoutes);
  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });
  return app;
}
