import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyError } from "fastify";
import { createPrisma } from "@zhixing/db";
import { remoteAppleJwks, type AppleJwks } from "./apple.js";
import { config } from "./config.js";
import { adminLinkTagsRoutes } from "./routes/adminLinkTags.js";
import { adminPlacesRoutes } from "./routes/adminPlaces.js";
import { adminReviewRoutes } from "./routes/adminReview.js";
import { authRoutes } from "./routes/auth.js";
import { cardsRoutes } from "./routes/cards.js";
import { favoritesRoutes } from "./routes/favorites.js";
import { footprintsRoutes } from "./routes/footprints.js";
import { interactionsRoutes } from "./routes/interactions.js";
import { photosRoutes } from "./routes/photos.js";
import { placesRoutes } from "./routes/places.js";
import { publicRoutes } from "./routes/public.js";
import { reportsRoutes } from "./routes/reports.js";
import { searchRoutes } from "./routes/search.js";
import { tripsRoutes } from "./routes/trips.js";
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
  rateLimit?: false | { max?: number };
  trustProxy?: boolean;
}

export function buildApp(opts: BuildAppOpts = {}) {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: opts.trustProxy ?? config.trustProxy });
  const prisma = createPrisma(opts.databaseUrl ?? config.databaseUrl);
  app.decorate("prisma", prisma);
  app.decorate("appleJwks", opts.appleJwks ?? remoteAppleJwks());
  app.decorate("devAuth", opts.devAuth ?? config.devAuth);
  const storage = createStorage({ ...config.s3, bucket: opts.s3Bucket ?? config.s3.bucket });
  app.decorate("storage", storage);
  // 统一错误形状（deploy.md 部署前硬化清单第 3 项）：框架级 404/413/500 收敛为 { error }。
  // 路由内手写的 reply.code().send({ error }) 不经过这里，零波及；@fastify/rate-limit 的
  // 429 由插件自答、不经 errorHandler，体形保持现状——客户端按 HTTP status 判别（见规格
  // 与 iOS EmailAuthRules 注释）。5xx 绝不回显 err.message（防内部信息/堆栈泄漏），细节只进日志。
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "not_found" }));
  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      req.log.error(err);
      return reply.code(500).send({ error: "internal_error" });
    }
    if (status === 413) return reply.code(413).send({ error: "payload_too_large" });
    if (status === 400) return reply.code(400).send({ error: "invalid_body" });
    return reply.code(status).send({ error: "request_error" });
  });
  app.addHook("onReady", async () => {
    await storage.ensureBucket();
  });
  if (opts.rateLimit !== false) {
    app.register(rateLimit, {
      max: opts.rateLimit?.max ?? 300,
      timeWindow: "1 minute",
      keyGenerator: (req) => req.headers.authorization ?? req.ip,
    });
  }
  app.register(cors, { origin: true });
  app.register(multipart, { limits: { fileSize: 15 * 1024 * 1024, files: 1 } });
  // 用 .after() 而非裸 app.get，确保限流插件的 onRequest 钩子（异步挂载）
  // 已完成注册后，这两个路由才被绑定——否则限流插件注册顺序虽在前，
  // 但同步声明的裸路由会先于其钩子挂载完成，导致不限流。
  app.after(() => {
    app.get("/health", async () => ({ ok: true }));
    app.get("/app-config", async () => ({ shareLandingUrl: config.shareLandingUrl }));
  });
  app.register(placesRoutes);
  app.register(adminPlacesRoutes);
  app.register(adminLinkTagsRoutes);
  app.register(cardsRoutes);
  app.register(authRoutes);
  app.register(footprintsRoutes);
  app.register(interactionsRoutes);
  app.register(photosRoutes);
  app.register(publicRoutes);
  app.register(searchRoutes);
  app.register(favoritesRoutes);
  app.register(reportsRoutes);
  app.register(tripsRoutes);
  app.register(adminReviewRoutes);
  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });
  return app;
}
