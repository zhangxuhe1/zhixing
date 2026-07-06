# 知行 M0 地基阶段 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭建知行的服务端地基：数据模型 + 后端 API + 管理后台 + AI 内容管线，并灌入北京首批地点与风物卡，达到规格书 M0 过关标准（管线一次运行可产出 10+ 张 AI 风物卡）。

**Architecture:** pnpm monorepo，四个包：`packages/db`（Prisma schema 与客户端，唯一数据模型来源）、`apps/api`（Fastify 单体 API）、`apps/admin`（Next.js 管理后台，本地自用）、`apps/pipeline`（TS 脚本：地点库导入 + AI 风物卡生成，直接写库为 AI_GENERATED 状态）。PostgreSQL 16 跑在 Docker Compose。iOS App 不在本计划范围（M1 单独出计划，需 macOS）。

**Tech Stack:** Node 22 + TypeScript (ESM, strict) / pnpm workspaces / Fastify 5 + zod / Prisma 6 + PostgreSQL 16 / Next.js 15 + React 19 / vitest（真实 PG，不 mock DB）/ @anthropic-ai/sdk（结构化输出 + web_search 工具）

**规格书:** `docs/superpowers/specs/2026-07-06-zhixing-design.md`（本计划实现其 M0 范围：§3 内容策略、§4 技术方案中的服务端部分）

## Global Constraints

- Node >= 22，pnpm 10；所有包 `"type": "module"`，TypeScript strict，module/moduleResolution = NodeNext
- PostgreSQL 16（docker compose 服务名 `db`）；开发库 `zhixing`，测试库 `zhixing_test`，账号 `zhixing`/`zhixing`
- 默认端口：API `8787`、admin `3000`、Postgres `5432`；开发默认值硬编码在 config 中与 compose 对齐，本地零环境变量可跑
- 管理接口鉴权：`Authorization: Bearer <ADMIN_TOKEN>`，默认 `dev-admin-token`（M0 本地内测专用）
- 风物卡状态机（规格书 §2.2/§3.2）：`AI_GENERATED → REVIEWED`（复核）；任意非 RETIRED → `RETIRED`（下架）；无其他迁移，不可逆
- 风物卡五分类枚举：`CUSTOMS`(习俗) `FOOD`(吃食) `DIALECT`(方言) `ANECDOTE`(掌故) `PLACE_NAME`(地名由来)
- 内容块类型枚举：`TEXT` `IMAGE` `AUDIO` `VIDEO`（M0 只生产 TEXT，结构预留全部——规格书 §2.2）
- LLM 调用：`@anthropic-ai/sdk`；模型默认 `claude-opus-4-8`（env `ZHIXING_GEN_MODEL` 可覆写）；`thinking: {type: "adaptive"}`；**禁止**设置 `temperature`/`top_p`/`top_k`（Opus 4.8 会 400）；凭据取 `ANTHROPIC_API_KEY` 或 `ant auth login` 的 profile（SDK 零参构造自动解析）
- 自动化测试不调真实 LLM API；live 生成只作为手动验收步骤
- 每个 git commit message 末尾追加：`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
- 仓库根目录 = `/root/idea/zhixing`，下文所有路径相对于它

---

### Task 1: Monorepo 脚手架 + Postgres

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `.env.example`, `docker-compose.yml`, `docker/initdb/01-test-db.sql`, `README.md`

**Interfaces:**
- Produces: pnpm workspace（`packages/*`, `apps/*`）；运行中的 Postgres（库 `zhixing` + `zhixing_test`）；基础 tsconfig 供各包 extends

- [ ] **Step 1: 写根配置文件**

`package.json`:
```json
{
  "name": "zhixing",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "db:up": "docker compose up -d db",
    "db:down": "docker compose down",
    "test": "pnpm -r --if-present test"
  }
}
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "packages/*"
  - "apps/*"
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "noEmit": true
  }
}
```

`.gitignore`:
```
node_modules/
.next/
dist/
*.log
.env
.DS_Store
```

`.env.example`:
```
# 全部可选——默认值与 docker-compose 对齐，本地开发可以不配
# DATABASE_URL=postgresql://zhixing:zhixing@localhost:5432/zhixing
# TEST_DATABASE_URL=postgresql://zhixing:zhixing@localhost:5432/zhixing_test
# ADMIN_TOKEN=dev-admin-token
# PORT=8787
# 内容管线需要（或使用 ant auth login 的 profile）：
# ANTHROPIC_API_KEY=sk-ant-...
# ZHIXING_GEN_MODEL=claude-opus-4-8
```

`docker-compose.yml`:
```yaml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: zhixing
      POSTGRES_PASSWORD: zhixing
      POSTGRES_DB: zhixing
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./docker/initdb:/docker-entrypoint-initdb.d
volumes:
  pgdata:
```

`docker/initdb/01-test-db.sql`:
```sql
CREATE DATABASE zhixing_test OWNER zhixing;
```

`README.md`:
```markdown
# 知行 zhixing

一张有故事的中国地图。产品设计见 docs/superpowers/specs/2026-07-06-zhixing-design.md。

## 开发

​```sh
pnpm install
pnpm db:up                      # 启动 Postgres（zhixing + zhixing_test 两个库）
pnpm --filter @zhixing/db exec prisma migrate dev   # 建表
pnpm --filter @zhixing/api dev  # API :8787
pnpm --filter @zhixing/admin dev # 管理后台 :3000
pnpm test                       # 全部测试
​```
```
（注意：写入文件时使用真实的三反引号代码块，上面为避免嵌套用了零宽转义。）

- [ ] **Step 2: 启动数据库并验证**

Run: `docker compose up -d db && sleep 5 && docker compose exec -T db pg_isready -U zhixing`
Expected: `... accepting connections`

Run: `docker compose exec -T db psql -U zhixing -d zhixing_test -c "select 1"`
Expected: 输出 `1 row`（证明测试库已由 init 脚本创建）

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "chore: monorepo 脚手架与 Postgres compose

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: packages/db — Prisma 数据模型

**Files:**
- Create: `packages/db/package.json`, `packages/db/tsconfig.json`, `packages/db/prisma/schema.prisma`, `packages/db/src/index.ts`, `packages/db/vitest.config.ts`, `packages/db/test/schema.test.ts`

**Interfaces:**
- Produces: npm 包 `@zhixing/db`，导出 `createPrisma(databaseUrl?: string): PrismaClient` 以及 `@prisma/client` 的全部类型与枚举（`PlaceLevel`, `CardCategory`, `CardStatus`, `BlockType`, `Visibility`, `ReviewStatus`, `Prisma` 等）。后续所有任务从 `@zhixing/db` 导入，不直接依赖 `@prisma/client`。

- [ ] **Step 1: 写包配置**

`packages/db/package.json`:
```json
{
  "name": "@zhixing/db",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "test": "vitest run",
    "push:test": "DATABASE_URL=postgresql://zhixing:zhixing@localhost:5432/zhixing_test prisma db push --skip-generate"
  },
  "dependencies": { "@prisma/client": "^6" },
  "devDependencies": { "prisma": "^6", "typescript": "^5", "vitest": "^3" }
}
```

`packages/db/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

- [ ] **Step 2: 写 schema.prisma（完整数据模型，规格书 §4.2）**

`packages/db/prisma/schema.prisma`:
```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum PlaceLevel {
  PROVINCE
  CITY
  DISTRICT // 区县 / 古镇 / 街区
  POI
}

enum CardCategory {
  CUSTOMS    // 习俗
  FOOD       // 吃食
  DIALECT    // 方言
  ANECDOTE   // 掌故
  PLACE_NAME // 地名由来
}

enum CardStatus {
  AI_GENERATED // AI 整理·待复核（可上架，卡面带标识）
  REVIEWED     // 已人工复核
  RETIRED      // 下架
}

enum BlockType {
  TEXT
  IMAGE
  AUDIO
  VIDEO
}

enum Visibility {
  PRIVATE
  PUBLIC
}

enum ReviewStatus {
  PENDING
  APPROVED
  REJECTED
}

model Place {
  id         String      @id @default(cuid())
  name       String
  level      PlaceLevel
  parentId   String?
  parent     Place?      @relation("PlaceTree", fields: [parentId], references: [id])
  children   Place[]     @relation("PlaceTree")
  lat        Float
  lng        Float
  intro      String?
  cards      Card[]
  footprints Footprint[]
  createdAt  DateTime    @default(now())

  @@unique([name, parentId])
  @@index([level])
}

model Card {
  id        String       @id @default(cuid())
  placeId   String
  place     Place        @relation(fields: [placeId], references: [id])
  category  CardCategory
  title     String
  status    CardStatus   @default(AI_GENERATED)
  sources   Json // string[] 参考来源
  blocks    CardBlock[]
  createdAt DateTime     @default(now())
  updatedAt DateTime     @updatedAt

  @@index([placeId, status])
}

model CardBlock {
  id       String    @id @default(cuid())
  cardId   String
  card     Card      @relation(fields: [cardId], references: [id], onDelete: Cascade)
  order    Int
  type     BlockType
  text     String? // TEXT 块内容
  mediaUrl String? // IMAGE/AUDIO/VIDEO 块的媒体地址（M0 预留）

  @@unique([cardId, order])
}

model User {
  id         String      @id @default(cuid())
  appleSub   String      @unique // Sign in with Apple 的 subject
  nickname   String
  createdAt  DateTime    @default(now())
  footprints Footprint[]
}

model Footprint {
  id           String          @id @default(cuid())
  userId       String
  user         User            @relation(fields: [userId], references: [id])
  placeId      String
  place        Place           @relation(fields: [placeId], references: [id])
  text         String?
  date         DateTime
  visibility   Visibility      @default(PRIVATE)
  reviewStatus ReviewStatus    @default(PENDING)
  likeCount    Int             @default(0)
  viewCount    Int             @default(0)
  photos       FootprintPhoto[]
  createdAt    DateTime        @default(now())

  @@index([placeId, visibility])
  @@index([userId])
}

model FootprintPhoto {
  id          String    @id @default(cuid())
  footprintId String
  footprint   Footprint @relation(fields: [footprintId], references: [id], onDelete: Cascade)
  mediaUrl    String
  takenAt     DateTime?
  lat         Float? // 原始坐标；公开展示时由服务端脱敏到地点级
  lng         Float?
}

model SearchMiss {
  id     String   @id @default(cuid())
  query  String   @unique
  count  Int      @default(1)
  lastAt DateTime @updatedAt
}
```

- [ ] **Step 3: 写客户端导出**

`packages/db/src/index.ts`:
```ts
export * from "@prisma/client";
import { PrismaClient } from "@prisma/client";

export function createPrisma(databaseUrl?: string): PrismaClient {
  return new PrismaClient(databaseUrl ? { datasourceUrl: databaseUrl } : undefined);
}
```

- [ ] **Step 4: 安装依赖并建表**

Run: `pnpm install`
Expected: 无报错，生成 pnpm-lock.yaml

Run: `DATABASE_URL=postgresql://zhixing:zhixing@localhost:5432/zhixing pnpm --filter @zhixing/db exec prisma migrate dev --name init`
Expected: `Your database is now in sync with your schema`（Prisma 从 env 读 DATABASE_URL，必须前置）

Run: `pnpm --filter @zhixing/db run push:test`
Expected: 测试库同步成功

- [ ] **Step 5: 写失败测试（Place↔Card 回环）**

`packages/db/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { fileParallelism: false } });
```

`packages/db/test/schema.test.ts`:
```ts
import { afterAll, beforeEach, expect, test } from "vitest";
import { createPrisma } from "../src/index.js";

const prisma = createPrisma(
  process.env.TEST_DATABASE_URL ?? "postgresql://zhixing:zhixing@localhost:5432/zhixing_test",
);

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "FootprintPhoto","Footprint","CardBlock","Card","Place","User","SearchMiss" RESTART IDENTITY CASCADE',
  );
});
afterAll(async () => prisma.$disconnect());

test("创建地点与多块风物卡并按 order 读回", async () => {
  const place = await prisma.place.create({
    data: { name: "什刹海", level: "DISTRICT", lat: 39.94, lng: 116.38 },
  });
  const card = await prisma.card.create({
    data: {
      placeId: place.id,
      category: "ANECDOTE",
      title: "银锭观山",
      sources: ["《燕都游览志》"],
      blocks: {
        create: [
          { order: 0, type: "TEXT", text: "第一段" },
          { order: 1, type: "TEXT", text: "第二段" },
        ],
      },
    },
  });
  const read = await prisma.card.findUniqueOrThrow({
    where: { id: card.id },
    include: { blocks: { orderBy: { order: "asc" } } },
  });
  expect(read.status).toBe("AI_GENERATED"); // 默认状态即 AI 生成
  expect(read.blocks.map((b) => b.text)).toEqual(["第一段", "第二段"]);
});
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm --filter @zhixing/db test`
Expected: `1 passed`

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(db): Prisma 数据模型（地点/风物卡/内容块/足迹/用户/搜索缺失）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: apps/api — Fastify 骨架与 /health

**Files:**
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/vitest.config.ts`, `apps/api/src/config.ts`, `apps/api/src/app.ts`, `apps/api/src/server.ts`, `apps/api/src/auth.ts`, `apps/api/test/helpers.ts`, `apps/api/test/health.test.ts`

**Interfaces:**
- Consumes: `@zhixing/db` 的 `createPrisma(url?)`
- Produces: `buildApp(opts?: { databaseUrl?: string }): FastifyInstance`（挂 `app.prisma`）；`requireAdmin` preHandler；测试助手 `testApp()` 与 `resetDb(app)`；`pnpm --filter @zhixing/api dev` 起服务于 :8787

- [ ] **Step 1: 写包配置**

`apps/api/package.json`:
```json
{
  "name": "@zhixing/api",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "@fastify/cors": "^10",
    "@zhixing/db": "workspace:*",
    "fastify": "^5",
    "zod": "^3.25"
  },
  "devDependencies": { "tsx": "^4", "typescript": "^5", "vitest": "^3" }
}
```

`apps/api/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

`apps/api/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { fileParallelism: false } });
```

- [ ] **Step 2: 写失败测试**

`apps/api/test/helpers.ts`:
```ts
import { buildApp } from "../src/app.js";

export const TEST_DB_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://zhixing:zhixing@localhost:5432/zhixing_test";

export function testApp() {
  return buildApp({ databaseUrl: TEST_DB_URL });
}

export async function resetDb(app: ReturnType<typeof buildApp>) {
  await app.prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "FootprintPhoto","Footprint","CardBlock","Card","Place","User","SearchMiss" RESTART IDENTITY CASCADE',
  );
}

export const ADMIN_AUTH = { authorization: "Bearer dev-admin-token" };
```

`apps/api/test/health.test.ts`:
```ts
import { afterAll, expect, test } from "vitest";
import { testApp } from "./helpers.js";

const app = testApp();
afterAll(async () => app.close());

test("GET /health 返回 ok", async () => {
  const res = await app.inject({ method: "GET", url: "/health" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm install && pnpm --filter @zhixing/api test`
Expected: FAIL（`Cannot find module '../src/app.js'` 或类似）

- [ ] **Step 4: 写实现**

`apps/api/src/config.ts`:
```ts
export const config = {
  port: Number(process.env.PORT ?? 8787),
  adminToken: process.env.ADMIN_TOKEN ?? "dev-admin-token",
  databaseUrl:
    process.env.DATABASE_URL ?? "postgresql://zhixing:zhixing@localhost:5432/zhixing",
};
```

`apps/api/src/auth.ts`:
```ts
import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  if (req.headers.authorization !== `Bearer ${config.adminToken}`) {
    return reply.code(401).send({ error: "unauthorized" });
  }
}
```

`apps/api/src/app.ts`:
```ts
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
```

`apps/api/src/server.ts`:
```ts
import { buildApp } from "./app.js";
import { config } from "./config.js";

const app = buildApp();
app.listen({ port: config.port, host: "0.0.0.0" }).then(() => {
  console.log(`zhixing api listening on :${config.port}`);
});
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm --filter @zhixing/api test`
Expected: `1 passed`

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(api): Fastify 骨架、health 路由与管理鉴权

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: apps/api — 地点路由

**Files:**
- Modify: `apps/api/src/app.ts`（注册路由）
- Create: `apps/api/src/routes/places.ts`, `apps/api/test/places.test.ts`

**Interfaces:**
- Consumes: `app.prisma`、`requireAdmin`
- Produces: `GET /places?level=&parentId=`（列表）、`GET /places/:id`（含 children）、`POST /admin/places`（201 返回创建的 Place）。后续 admin 前端与验收依赖这三个路由。

- [ ] **Step 1: 写失败测试**

`apps/api/test/places.test.ts`:
```ts
import { afterAll, beforeEach, expect, test } from "vitest";
import { ADMIN_AUTH, resetDb, testApp } from "./helpers.js";

const app = testApp();
beforeEach(() => resetDb(app));
afterAll(async () => app.close());

test("POST /admin/places 需要鉴权", async () => {
  const res = await app.inject({ method: "POST", url: "/admin/places", payload: {} });
  expect(res.statusCode).toBe(401);
});

test("创建并查询地点树", async () => {
  const city = await app.inject({
    method: "POST",
    url: "/admin/places",
    headers: ADMIN_AUTH,
    payload: { name: "北京市", level: "CITY", lat: 39.9042, lng: 116.4074 },
  });
  expect(city.statusCode).toBe(201);
  const cityId = city.json().id as string;

  const spot = await app.inject({
    method: "POST",
    url: "/admin/places",
    headers: ADMIN_AUTH,
    payload: { name: "什刹海", level: "DISTRICT", parentId: cityId, lat: 39.94, lng: 116.383 },
  });
  expect(spot.statusCode).toBe(201);

  const list = await app.inject({ method: "GET", url: `/places?parentId=${cityId}` });
  expect(list.json().map((p: { name: string }) => p.name)).toEqual(["什刹海"]);

  const detail = await app.inject({ method: "GET", url: `/places/${cityId}` });
  expect(detail.json().children).toHaveLength(1);
});

test("非法 body 返回 400", async () => {
  const res = await app.inject({
    method: "POST",
    url: "/admin/places",
    headers: ADMIN_AUTH,
    payload: { name: "", level: "BAD" },
  });
  expect(res.statusCode).toBe(400);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @zhixing/api test`
Expected: FAIL（places 路由 404）

- [ ] **Step 3: 写实现**

`apps/api/src/routes/places.ts`:
```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "../auth.js";

const levelEnum = z.enum(["PROVINCE", "CITY", "DISTRICT", "POI"]);

const listQuerySchema = z.object({
  level: levelEnum.optional(),
  parentId: z.string().optional(),
});

const createPlaceSchema = z.object({
  name: z.string().min(1),
  level: levelEnum,
  parentId: z.string().nullish(),
  lat: z.number(),
  lng: z.number(),
  intro: z.string().optional(),
});

export async function placesRoutes(app: FastifyInstance) {
  app.get("/places", async (req, reply) => {
    const q = listQuerySchema.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid_query" });
    return app.prisma.place.findMany({
      where: { level: q.data.level, parentId: q.data.parentId },
      orderBy: { createdAt: "asc" },
    });
  });

  app.get("/places/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const place = await app.prisma.place.findUnique({
      where: { id },
      include: { children: true },
    });
    if (!place) return reply.code(404).send({ error: "not_found" });
    return place;
  });

  app.post("/admin/places", { preHandler: requireAdmin }, async (req, reply) => {
    const body = createPlaceSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    }
    const place = await app.prisma.place.create({
      data: { ...body.data, parentId: body.data.parentId ?? null },
    });
    return reply.code(201).send(place);
  });
}
```

在 `apps/api/src/app.ts` 中注册（`app.register(cors, ...)` 之后、`/health` 之后添加）：
```ts
import { placesRoutes } from "./routes/places.js";
// ... buildApp 内：
  app.register(placesRoutes);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @zhixing/api test`
Expected: 全部 passed（health 1 + places 3）

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(api): 地点查询与管理创建路由

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: apps/api — 风物卡路由与状态机

**Files:**
- Modify: `apps/api/src/app.ts`（注册路由）
- Create: `apps/api/src/routes/cards.ts`, `apps/api/test/cards.test.ts`

**Interfaces:**
- Consumes: `app.prisma`、`requireAdmin`
- Produces:
  - `GET /places/:id/cards` — 该地点非 RETIRED 卡列表，含按 order 升序的 blocks，按 createdAt 降序
  - `GET /cards/:id` — 单卡详情（含 blocks、place）
  - `POST /admin/cards` — 创建卡（body: `{placeId, category, title, sources: string[], blocks: [{type, text?, mediaUrl?}]}`，blocks 按数组序写 order），201
  - `PATCH /admin/cards/:id` — 更新 title/sources，或整组替换 blocks
  - `POST /admin/cards/:id/status` — body `{action: "review" | "retire"}`；非法迁移返回 409 `{error: "invalid_transition"}`
  - 管线（Task 9）与 admin 前端（Task 6）都依赖这些路由与 body 形状

- [ ] **Step 1: 写失败测试**

`apps/api/test/cards.test.ts`:
```ts
import { afterAll, beforeEach, expect, test } from "vitest";
import { ADMIN_AUTH, resetDb, testApp } from "./helpers.js";

const app = testApp();
beforeEach(() => resetDb(app));
afterAll(async () => app.close());

async function makePlace() {
  return app.prisma.place.create({
    data: { name: "什刹海", level: "DISTRICT", lat: 39.94, lng: 116.383 },
  });
}

const cardPayload = (placeId: string) => ({
  placeId,
  category: "ANECDOTE",
  title: "银锭观山",
  sources: ["《燕都游览志》"],
  blocks: [
    { type: "TEXT", text: "站在银锭桥上向西望，是老燕京八景之外的第九景。" },
    { type: "TEXT", text: "相传桥形似倒扣的银锭，故得名。" },
  ],
});

test("创建卡并公开读取（默认 AI_GENERATED）", async () => {
  const place = await makePlace();
  const created = await app.inject({
    method: "POST",
    url: "/admin/cards",
    headers: ADMIN_AUTH,
    payload: cardPayload(place.id),
  });
  expect(created.statusCode).toBe(201);
  expect(created.json().status).toBe("AI_GENERATED");

  const list = await app.inject({ method: "GET", url: `/places/${place.id}/cards` });
  expect(list.json()).toHaveLength(1);
  expect(list.json()[0].blocks.map((b: { text: string }) => b.text)).toEqual(
    cardPayload(place.id).blocks.map((b) => b.text),
  );

  const detail = await app.inject({ method: "GET", url: `/cards/${created.json().id}` });
  expect(detail.json().place.name).toBe("什刹海");
});

test("状态机：review 只能从 AI_GENERATED；retire 不可重复", async () => {
  const place = await makePlace();
  const created = await app.inject({
    method: "POST", url: "/admin/cards", headers: ADMIN_AUTH, payload: cardPayload(place.id),
  });
  const id = created.json().id as string;

  const review = await app.inject({
    method: "POST", url: `/admin/cards/${id}/status`, headers: ADMIN_AUTH,
    payload: { action: "review" },
  });
  expect(review.statusCode).toBe(200);
  expect(review.json().status).toBe("REVIEWED");

  const reviewAgain = await app.inject({
    method: "POST", url: `/admin/cards/${id}/status`, headers: ADMIN_AUTH,
    payload: { action: "review" },
  });
  expect(reviewAgain.statusCode).toBe(409);

  const retire = await app.inject({
    method: "POST", url: `/admin/cards/${id}/status`, headers: ADMIN_AUTH,
    payload: { action: "retire" },
  });
  expect(retire.json().status).toBe("RETIRED");

  const retireAgain = await app.inject({
    method: "POST", url: `/admin/cards/${id}/status`, headers: ADMIN_AUTH,
    payload: { action: "retire" },
  });
  expect(retireAgain.statusCode).toBe(409);

  const list = await app.inject({ method: "GET", url: `/places/${place.id}/cards` });
  expect(list.json()).toHaveLength(0); // RETIRED 不出现在公开列表
});

test("PATCH 替换 blocks 与更新标题", async () => {
  const place = await makePlace();
  const created = await app.inject({
    method: "POST", url: "/admin/cards", headers: ADMIN_AUTH, payload: cardPayload(place.id),
  });
  const id = created.json().id as string;

  const patched = await app.inject({
    method: "PATCH", url: `/admin/cards/${id}`, headers: ADMIN_AUTH,
    payload: { title: "银锭观山（改）", blocks: [{ type: "TEXT", text: "只剩一段" }] },
  });
  expect(patched.statusCode).toBe(200);
  expect(patched.json().title).toBe("银锭观山（改）");
  expect(patched.json().blocks).toHaveLength(1);
});

test("管理接口未鉴权 401", async () => {
  const res = await app.inject({ method: "POST", url: "/admin/cards", payload: {} });
  expect(res.statusCode).toBe(401);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @zhixing/api test`
Expected: cards 测试 FAIL（404）

- [ ] **Step 3: 写实现**

`apps/api/src/routes/cards.ts`:
```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireAdmin } from "../auth.js";

const blockSchema = z.object({
  type: z.enum(["TEXT", "IMAGE", "AUDIO", "VIDEO"]),
  text: z.string().optional(),
  mediaUrl: z.string().optional(),
});

const createCardSchema = z.object({
  placeId: z.string(),
  category: z.enum(["CUSTOMS", "FOOD", "DIALECT", "ANECDOTE", "PLACE_NAME"]),
  title: z.string().min(1),
  sources: z.array(z.string()).default([]),
  blocks: z.array(blockSchema).min(1),
});

const patchCardSchema = z.object({
  title: z.string().min(1).optional(),
  sources: z.array(z.string()).optional(),
  blocks: z.array(blockSchema).min(1).optional(),
});

const statusSchema = z.object({ action: z.enum(["review", "retire"]) });

const includeBlocks = { blocks: { orderBy: { order: "asc" as const } } };

export async function cardsRoutes(app: FastifyInstance) {
  app.get("/places/:id/cards", async (req) => {
    const { id } = req.params as { id: string };
    return app.prisma.card.findMany({
      where: { placeId: id, status: { not: "RETIRED" } },
      include: includeBlocks,
      orderBy: { createdAt: "desc" },
    });
  });

  app.get("/cards/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const card = await app.prisma.card.findUnique({
      where: { id },
      include: { ...includeBlocks, place: true },
    });
    if (!card) return reply.code(404).send({ error: "not_found" });
    return card;
  });

  app.post("/admin/cards", { preHandler: requireAdmin }, async (req, reply) => {
    const body = createCardSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    }
    const { blocks, ...rest } = body.data;
    const card = await app.prisma.card.create({
      data: {
        ...rest,
        blocks: { create: blocks.map((b, i) => ({ ...b, order: i })) },
      },
      include: includeBlocks,
    });
    return reply.code(201).send(card);
  });

  app.patch("/admin/cards/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = patchCardSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    }
    const existing = await app.prisma.card.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "not_found" });

    const { blocks, ...rest } = body.data;
    const card = await app.prisma.$transaction(async (tx) => {
      if (blocks) {
        await tx.cardBlock.deleteMany({ where: { cardId: id } });
        await tx.cardBlock.createMany({
          data: blocks.map((b, i) => ({ ...b, cardId: id, order: i })),
        });
      }
      return tx.card.update({ where: { id }, data: rest, include: includeBlocks });
    });
    return card;
  });

  app.post("/admin/cards/:id/status", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = statusSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_body" });

    const card = await app.prisma.card.findUnique({ where: { id } });
    if (!card) return reply.code(404).send({ error: "not_found" });

    const { action } = body.data;
    // 状态机（规格书 §3.2）：AI_GENERATED --review--> REVIEWED；非 RETIRED --retire--> RETIRED
    if (action === "review" && card.status !== "AI_GENERATED") {
      return reply.code(409).send({ error: "invalid_transition", from: card.status });
    }
    if (action === "retire" && card.status === "RETIRED") {
      return reply.code(409).send({ error: "invalid_transition", from: card.status });
    }
    const status = action === "review" ? "REVIEWED" : "RETIRED";
    return app.prisma.card.update({ where: { id }, data: { status }, include: includeBlocks });
  });
}
```

在 `apps/api/src/app.ts` 注册：
```ts
import { cardsRoutes } from "./routes/cards.js";
// buildApp 内 placesRoutes 之后：
  app.register(cardsRoutes);
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @zhixing/api test`
Expected: 全部 passed（health 1 + places 3 + cards 4）

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(api): 风物卡 CRUD 与复核/下架状态机

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: apps/admin — 管理后台（Next.js）

**Files:**
- Create: `apps/admin/package.json`, `apps/admin/tsconfig.json`, `apps/admin/next.config.mjs`, `apps/admin/next-env.d.ts`（next dev 自动生成）, `apps/admin/lib/api.ts`, `apps/admin/app/layout.tsx`, `apps/admin/app/globals.css`, `apps/admin/app/token-bar.tsx`, `apps/admin/app/page.tsx`, `apps/admin/app/places/page.tsx`, `apps/admin/app/cards/page.tsx`, `apps/admin/app/cards/[id]/page.tsx`

**Interfaces:**
- Consumes: Task 4/5 的全部 API 路由；token 存 `localStorage["zx_admin_token"]`，请求带 `Authorization: Bearer <token>`
- Produces: `pnpm --filter @zhixing/admin dev` → http://localhost:3000 的管理后台：地点列表、风物卡列表（按状态过滤）、卡片详情（复核/下架按钮）。够用即可，不追求好看（规格书 §4.1）。

- [ ] **Step 1: 写包配置与基础文件**

`apps/admin/package.json`:
```json
{
  "name": "@zhixing/admin",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": { "next": "^15", "react": "^19", "react-dom": "^19" },
  "devDependencies": { "@types/node": "^22", "@types/react": "^19", "typescript": "^5" }
}
```

`apps/admin/next.config.mjs`:
```js
/** @type {import('next').NextConfig} */
export default {};
```

`apps/admin/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

`apps/admin/app/globals.css`:
```css
body { font-family: system-ui, "PingFang SC", sans-serif; margin: 0; background: #fafafa; color: #222; }
main { max-width: 960px; margin: 0 auto; padding: 24px; }
nav { display: flex; gap: 16px; padding: 12px 24px; background: #1a1a1a; color: #fff; align-items: center; }
nav a { color: #fff; text-decoration: none; }
table { width: 100%; border-collapse: collapse; background: #fff; }
th, td { border: 1px solid #e5e5e5; padding: 8px 12px; text-align: left; font-size: 14px; }
button { padding: 6px 12px; cursor: pointer; }
.badge { padding: 2px 8px; border-radius: 4px; font-size: 12px; }
.badge.AI_GENERATED { background: #fff3cd; }
.badge.REVIEWED { background: #d1e7dd; }
.badge.RETIRED { background: #e2e3e5; }
.card-block { background: #fff; border: 1px solid #e5e5e5; padding: 12px 16px; margin: 8px 0; line-height: 1.8; }
```

- [ ] **Step 2: 写 API 封装与 Token 栏**

`apps/admin/lib/api.ts`:
```ts
export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

export function getToken(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("zx_admin_token") ?? "";
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${getToken()}`,
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json() as Promise<T>;
}
```

`apps/admin/app/token-bar.tsx`:
```tsx
"use client";
import { useEffect, useState } from "react";

export function TokenBar() {
  const [token, setToken] = useState("");
  useEffect(() => setToken(localStorage.getItem("zx_admin_token") ?? ""), []);
  return (
    <span style={{ marginLeft: "auto" }}>
      <input
        type="password"
        placeholder="ADMIN_TOKEN"
        value={token}
        onChange={(e) => {
          setToken(e.target.value);
          localStorage.setItem("zx_admin_token", e.target.value);
        }}
        style={{ padding: 4 }}
      />
    </span>
  );
}
```

`apps/admin/app/layout.tsx`:
```tsx
import "./globals.css";
import Link from "next/link";
import { TokenBar } from "./token-bar";

export const metadata = { title: "知行·管理后台" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <nav>
          <strong>知行后台</strong>
          <Link href="/places">地点库</Link>
          <Link href="/cards">风物卡</Link>
          <TokenBar />
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
```

`apps/admin/app/page.tsx`:
```tsx
export default function Home() {
  return <p>知行管理后台。左上角选择模块；右上角填写 ADMIN_TOKEN（默认 dev-admin-token）。</p>;
}
```

- [ ] **Step 3: 写地点与卡片页面**

`apps/admin/app/places/page.tsx`:
```tsx
"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

type Place = { id: string; name: string; level: string; parentId: string | null; lat: number; lng: number };

export default function PlacesPage() {
  const [places, setPlaces] = useState<Place[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    api<Place[]>("/places").then(setPlaces).catch((e) => setError(String(e)));
  }, []);
  return (
    <>
      <h2>地点库（{places.length}）</h2>
      {error && <p style={{ color: "red" }}>{error}</p>}
      <table>
        <thead><tr><th>名称</th><th>层级</th><th>坐标</th></tr></thead>
        <tbody>
          {places.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td>{p.level}</td>
              <td>{p.lat.toFixed(3)}, {p.lng.toFixed(3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
```

`apps/admin/app/cards/page.tsx`:
```tsx
"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

type Place = { id: string; name: string };
type Card = { id: string; title: string; category: string; status: string; placeId: string };

const CATEGORY_ZH: Record<string, string> = {
  CUSTOMS: "习俗", FOOD: "吃食", DIALECT: "方言", ANECDOTE: "掌故", PLACE_NAME: "地名由来",
};

export default function CardsPage() {
  const [places, setPlaces] = useState<Place[]>([]);
  const [placeId, setPlaceId] = useState("");
  const [cards, setCards] = useState<Card[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api<Place[]>("/places").then((ps) => {
      setPlaces(ps);
      if (ps.length > 0) setPlaceId(ps[0].id);
    }).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!placeId) return;
    api<Card[]>(`/places/${placeId}/cards`).then(setCards).catch((e) => setError(String(e)));
  }, [placeId]);

  return (
    <>
      <h2>风物卡</h2>
      {error && <p style={{ color: "red" }}>{error}</p>}
      <p>
        地点：
        <select value={placeId} onChange={(e) => setPlaceId(e.target.value)}>
          {places.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </p>
      <table>
        <thead><tr><th>标题</th><th>分类</th><th>状态</th></tr></thead>
        <tbody>
          {cards.map((c) => (
            <tr key={c.id}>
              <td><Link href={`/cards/${c.id}`}>{c.title}</Link></td>
              <td>{CATEGORY_ZH[c.category] ?? c.category}</td>
              <td><span className={`badge ${c.status}`}>{c.status}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
```

`apps/admin/app/cards/[id]/page.tsx`:
```tsx
"use client";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

type Block = { id: string; order: number; type: string; text: string | null; mediaUrl: string | null };
type Card = {
  id: string; title: string; category: string; status: string;
  sources: string[]; blocks: Block[]; place: { name: string };
};

export default function CardDetail() {
  const { id } = useParams<{ id: string }>();
  const [card, setCard] = useState<Card | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api<Card>(`/cards/${id}`).then(setCard).catch((e) => setError(String(e)));
  }, [id]);
  useEffect(load, [load]);

  async function transition(action: "review" | "retire") {
    try {
      await api(`/admin/cards/${id}/status`, { method: "POST", body: JSON.stringify({ action }) });
      load();
    } catch (e) {
      setError(String(e));
    }
  }

  if (!card) return <p>{error || "加载中…"}</p>;
  return (
    <>
      <h2>
        {card.title} <span className={`badge ${card.status}`}>{card.status}</span>
      </h2>
      <p>地点：{card.place.name}｜分类：{card.category}</p>
      <p>
        {card.status === "AI_GENERATED" && (
          <button onClick={() => transition("review")}>标记已复核</button>
        )}{" "}
        {card.status !== "RETIRED" && <button onClick={() => transition("retire")}>下架</button>}
      </p>
      {error && <p style={{ color: "red" }}>{error}</p>}
      {card.blocks.map((b) => (
        <div className="card-block" key={b.id}>
          {b.type === "TEXT" ? b.text : `[${b.type}] ${b.mediaUrl ?? ""}`}
        </div>
      ))}
      <h4>参考来源</h4>
      <ul>{card.sources.map((s, i) => <li key={i}>{s}</li>)}</ul>
    </>
  );
}
```

- [ ] **Step 4: 构建验证**

Run: `pnpm install && pnpm --filter @zhixing/admin build`
Expected: `✓ Compiled successfully`（Next 生成 next-env.d.ts；构建通过即类型无误）

- [ ] **Step 5: 手动冒烟（可选，需两个终端）**

Run: 终端 A `pnpm --filter @zhixing/api dev`；终端 B `pnpm --filter @zhixing/admin dev`；浏览器开 http://localhost:3000 → 右上角填 `dev-admin-token` → 「地点库」「风物卡」页面能加载（此时无数据为空表，正常）
Expected: 页面无报错；network 面板可见对 :8787 的请求 200

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(admin): 管理后台骨架（地点库/风物卡列表/卡片复核下架）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: apps/pipeline — 北京地点库种子数据与导入

**Files:**
- Create: `apps/pipeline/package.json`, `apps/pipeline/tsconfig.json`, `apps/pipeline/vitest.config.ts`, `apps/pipeline/data/beijing-places.json`, `apps/pipeline/src/import-places.ts`, `apps/pipeline/test/import.test.ts`

**Interfaces:**
- Consumes: `@zhixing/db` 的 `createPrisma`
- Produces: `importPlaces(prisma: PrismaClient, dataPath: string): Promise<{ city: Place; spotCount: number }>`（幂等，可重复执行）；CLI `pnpm --filter @zhixing/pipeline import-places`。Task 9 的 generate 依赖库中已有地点。

- [ ] **Step 1: 写包配置**

`apps/pipeline/package.json`:
```json
{
  "name": "@zhixing/pipeline",
  "private": true,
  "type": "module",
  "scripts": {
    "import-places": "tsx src/import-places.ts",
    "generate": "tsx src/generate.ts",
    "test": "vitest run"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.88",
    "@zhixing/db": "workspace:*",
    "zod": "^3.25"
  },
  "devDependencies": { "tsx": "^4", "typescript": "^5", "vitest": "^3" }
}
```
（安装时 pnpm 解析 `@anthropic-ai/sdk` 最新兼容版；若 `^0.88` 不存在以 `pnpm add @anthropic-ai/sdk@latest --filter @zhixing/pipeline` 安装并以 lockfile 为准。）

`apps/pipeline/tsconfig.json`:
```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

`apps/pipeline/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({ test: { fileParallelism: false } });
```

- [ ] **Step 2: 写种子数据（真实地点，坐标为近似值，后台可修正）**

`apps/pipeline/data/beijing-places.json`:
```json
{
  "city": { "name": "北京市", "level": "CITY", "lat": 39.9042, "lng": 116.4074, "intro": "六朝古都，皇城根下的胡同人间" },
  "spots": [
    { "name": "什刹海", "lat": 39.9403, "lng": 116.383, "intro": "前海后海西海，京城最有烟火气的水岸" },
    { "name": "烟袋斜街", "lat": 39.94, "lng": 116.385, "intro": "京城最老的斜街之一，因烟袋铺得名" },
    { "name": "南锣鼓巷", "lat": 39.937, "lng": 116.403, "intro": "元大都里坊格局的活化石" },
    { "name": "国子监街", "lat": 39.9455, "lng": 116.407, "intro": "进士题名碑下的槐荫老街" },
    { "name": "五道营胡同", "lat": 39.948, "lng": 116.406, "intro": "安定门内的安静胡同" },
    { "name": "牛街", "lat": 39.886, "lng": 116.362, "intro": "回民聚居的清真美食街" },
    { "name": "大栅栏", "lat": 39.896, "lng": 116.395, "intro": "老字号云集的前门商街" },
    { "name": "琉璃厂", "lat": 39.893, "lng": 116.386, "intro": "笔墨纸砚与古籍字画的文市" },
    { "name": "杨梅竹斜街", "lat": 39.895, "lng": 116.392, "intro": "民国书局一条街" },
    { "name": "鲜鱼口", "lat": 39.899, "lng": 116.401, "intro": "前门东侧的老字号食街" },
    { "name": "天桥", "lat": 39.879, "lng": 116.39, "intro": "撂跤说书的老北京市井江湖" },
    { "name": "潭柘寺", "lat": 39.9, "lng": 116.026, "intro": "先有潭柘寺，后有北京城" },
    { "name": "爨底下村", "lat": 39.993, "lng": 115.644, "intro": "京西古道上的明清山村" },
    { "name": "古北口镇", "lat": 40.689, "lng": 117.16, "intro": "长城脚下的边关重镇" },
    { "name": "张家湾古镇", "lat": 39.853, "lng": 116.71, "intro": "大运河漕运的北方码头" }
  ]
}
```

- [ ] **Step 3: 写失败测试**

`apps/pipeline/test/import.test.ts`:
```ts
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, expect, test } from "vitest";
import { createPrisma } from "@zhixing/db";
import { importPlaces } from "../src/import-places.js";

const prisma = createPrisma(
  process.env.TEST_DATABASE_URL ?? "postgresql://zhixing:zhixing@localhost:5432/zhixing_test",
);
const dataPath = fileURLToPath(new URL("../data/beijing-places.json", import.meta.url));

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "FootprintPhoto","Footprint","CardBlock","Card","Place","User","SearchMiss" RESTART IDENTITY CASCADE',
  );
});
afterAll(async () => prisma.$disconnect());

test("导入北京地点库，幂等可重复执行", async () => {
  const first = await importPlaces(prisma, dataPath);
  expect(first.spotCount).toBe(15);

  const again = await importPlaces(prisma, dataPath); // 第二次执行不重复建
  expect(again.spotCount).toBe(15);
  expect(await prisma.place.count()).toBe(16); // 1 城市 + 15 街区

  const spot = await prisma.place.findFirstOrThrow({ where: { name: "什刹海" } });
  expect(spot.parentId).toBe(first.city.id);
  expect(spot.level).toBe("DISTRICT");
});
```

- [ ] **Step 4: 跑测试确认失败**

Run: `pnpm install && pnpm --filter @zhixing/pipeline test`
Expected: FAIL（`Cannot find module '../src/import-places.js'`）

- [ ] **Step 5: 写实现**

`apps/pipeline/src/import-places.ts`:
```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPrisma, type Place, type PrismaClient } from "@zhixing/db";

type SeedFile = {
  city: { name: string; level: "CITY"; lat: number; lng: number; intro?: string };
  spots: Array<{ name: string; lat: number; lng: number; intro?: string }>;
};

export async function importPlaces(
  prisma: PrismaClient,
  dataPath: string,
): Promise<{ city: Place; spotCount: number }> {
  const seed = JSON.parse(readFileSync(dataPath, "utf-8")) as SeedFile;

  // 顶层地点 parentId 为 null，复合唯一键对 null 不生效，用 findFirst+create 保证幂等
  let city = await prisma.place.findFirst({ where: { name: seed.city.name, parentId: null } });
  if (!city) {
    city = await prisma.place.create({ data: seed.city });
  }

  for (const s of seed.spots) {
    await prisma.place.upsert({
      where: { name_parentId: { name: s.name, parentId: city.id } },
      update: { lat: s.lat, lng: s.lng, intro: s.intro },
      create: { ...s, level: "DISTRICT", parentId: city.id },
    });
  }
  return { city, spotCount: seed.spots.length };
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const prisma = createPrisma(process.env.DATABASE_URL);
  const dataPath = fileURLToPath(new URL("../data/beijing-places.json", import.meta.url));
  importPlaces(prisma, dataPath)
    .then((r) => console.log(`imported: ${r.city.name} + ${r.spotCount} spots`))
    .finally(() => prisma.$disconnect());
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm --filter @zhixing/pipeline test`
Expected: `1 passed`

- [ ] **Step 7: 对开发库执行导入**

Run: `pnpm --filter @zhixing/pipeline import-places`
Expected: `imported: 北京市 + 15 spots`（DATABASE_URL 未设时 createPrisma(undefined) 走 schema env——先 `export DATABASE_URL=postgresql://zhixing:zhixing@localhost:5432/zhixing` 再执行）

- [ ] **Step 8: Commit**

```bash
git add -A && git commit -m "feat(pipeline): 北京地点库种子数据与幂等导入

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: apps/pipeline — 写作模板 Prompt 与卡片草稿 Schema

**Files:**
- Create: `apps/pipeline/src/prompts.ts`, `apps/pipeline/src/schema.ts`, `apps/pipeline/test/prompts.test.ts`, `apps/pipeline/test/schema.test.ts`

**Interfaces:**
- Produces（Task 9 消费，签名必须一致）:
  - `CATEGORY_LABELS: Record<Category, string>`、`type Category = "CUSTOMS" | "FOOD" | "DIALECT" | "ANECDOTE" | "PLACE_NAME"`
  - `TEMPLATE_RULES: string`（规格书 §3.3 写作规则全文）
  - `buildResearchPrompt(placeName: string, cityName: string, category: Category): string`
  - `buildCardPrompt(opts: { placeName: string; cityName: string; category: Category; notes: string | null; existingTitles: string[] }): string`
  - `cardDraftSchema`（zod）与 `type CardDraft = { title: string; blocks: { type: "text"; content: string }[]; sources: string[] }`

- [ ] **Step 1: 写失败测试**

`apps/pipeline/test/schema.test.ts`:
```ts
import { expect, test } from "vitest";
import { cardDraftSchema } from "../src/schema.js";

const valid = {
  title: "卤煮火烧的出身",
  blocks: [
    {
      type: "text",
      content:
        "天没亮透，南横街的小肠陈门口已经排上了队。大锅里咕嘟着小肠、肺头、炸豆腐，师傅捞起火烧，井字四刀，浇一勺老汤。一说卤煮的祖上是宫廷苏造肉，乾隆年间苏州厨子张东官带进御膳房，后来流入民间，五花肉贵，脚夫吃不起，摊主改用下水，歪打正着成了穷人乐。",
    },
  ],
  sources: ["《北京志·商业卷》"],
};

test("合法草稿通过校验", () => {
  expect(cardDraftSchema.parse(valid)).toEqual(valid);
});

test("空来源 / 空块 / 超长标题被拒绝", () => {
  expect(cardDraftSchema.safeParse({ ...valid, sources: [] }).success).toBe(false);
  expect(cardDraftSchema.safeParse({ ...valid, blocks: [] }).success).toBe(false);
  expect(
    cardDraftSchema.safeParse({ ...valid, title: "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十多" }).success,
  ).toBe(false);
});
```

`apps/pipeline/test/prompts.test.ts`:
```ts
import { expect, test } from "vitest";
import { buildCardPrompt, buildResearchPrompt, CATEGORY_LABELS, TEMPLATE_RULES } from "../src/prompts.js";

test("写作规则包含规格书 §3.3 的关键约束", () => {
  expect(TEMPLATE_RULES).toContain("300");
  expect(TEMPLATE_RULES).toContain("细节锚点");
  expect(TEMPLATE_RULES).toContain("相传");
  expect(TEMPLATE_RULES).toContain("不总结、不升华");
});

test("研究 prompt 带地点与分类", () => {
  const p = buildResearchPrompt("什刹海", "北京市", "ANECDOTE");
  expect(p).toContain("什刹海");
  expect(p).toContain("北京市");
  expect(p).toContain(CATEGORY_LABELS.ANECDOTE);
});

test("写卡 prompt 包含规则、资料与已有标题去重要求", () => {
  const p = buildCardPrompt({
    placeName: "什刹海",
    cityName: "北京市",
    category: "FOOD",
    notes: "【资料】烤肉季始于清道光年间……",
    existingTitles: ["银锭观山"],
  });
  expect(p).toContain(TEMPLATE_RULES);
  expect(p).toContain("烤肉季");
  expect(p).toContain("银锭观山");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @zhixing/pipeline test`
Expected: 新测试 FAIL（模块不存在）

- [ ] **Step 3: 写实现**

`apps/pipeline/src/schema.ts`:
```ts
import { z } from "zod";

export const cardDraftSchema = z.object({
  title: z.string().min(2).max(30),
  blocks: z
    .array(z.object({ type: z.literal("text"), content: z.string().min(50) }))
    .min(1)
    .max(6),
  sources: z.array(z.string().min(2)).min(1).max(8),
});

export type CardDraft = z.infer<typeof cardDraftSchema>;
```

`apps/pipeline/src/prompts.ts`:
```ts
export const CATEGORY_LABELS = {
  CUSTOMS: "习俗",
  FOOD: "吃食",
  DIALECT: "方言",
  ANECDOTE: "掌故",
  PLACE_NAME: "地名由来",
} as const;

export type Category = keyof typeof CATEGORY_LABELS;

// 规格书 §3.3 风物卡写作模板
export const TEMPLATE_RULES = `写作规则（必须全部遵守）：
1. 开头禁止百科腔：不得以"XX是一种""XX位于""XX始建于"这类定义句开头，必须以场景、人物或对话切入。
2. 全文 300–500 字（各文本块合计），可拆 1–3 个自然段落块。
3. 至少包含一个细节锚点：具体的店名、人名、年代、俗语原文或数字。
4. 传说与史实分开：无法确证的内容用"相传""一说"标注，不得把传说写成史实。
5. 方言类卡片：必须给出词条、拼音近似注音、例句和使用场景。
6. 结尾不总结、不升华：禁止"这正是……的体现""如今……依然"式收尾，讲完就停。
7. sources 填写参考来源（书名/志书/文章名；若引用了检索到的网页，写"标题 - 域名"）。`;

export function buildResearchPrompt(placeName: string, cityName: string, category: Category): string {
  return `你在为一个人文地图 App 收集写作素材。目标地点：${cityName}·${placeName}，内容分类：${CATEGORY_LABELS[category]}。

请检索并汇集这个地点在该分类下值得写的素材：具体的店名、人名、年代、俗语、掌故、出处。优先地方志、正规媒体与文化类文章，忽略营销软文。

输出一份条目化的素材笔记：每条素材附一句来源说明（书名/文章标题与域名）。如果检索不到可靠素材，明确说明哪些内容只能依据常识背景。不要成文，只要素材。`;
}

export function buildCardPrompt(opts: {
  placeName: string;
  cityName: string;
  category: Category;
  notes: string | null;
  existingTitles: string[];
}): string {
  const { placeName, cityName, category, notes, existingTitles } = opts;
  const dedupe =
    existingTitles.length > 0
      ? `该地点已有以下卡片，选题与标题不得重复或近似：${existingTitles.join("、")}。`
      : "";
  const material = notes
    ? `以下是检索到的素材笔记，写作时以此为主要依据：\n${notes}`
    : "没有检索素材，仅依据你可靠的知识写作；不确定的内容一律用\"相传\"\"一说\"标注。";

  return `你在为人文地图 App「知行」写一张「风物卡」——关于一个地方风土人情的小故事。

地点：${cityName}·${placeName}
分类：${CATEGORY_LABELS[category]}
${dedupe}

${TEMPLATE_RULES}

${material}

按输出格式返回：title（2–30 字，有钩子，不用书名号）、blocks（1–3 个 text 块，合计 300–500 字）、sources（至少 1 条）。`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @zhixing/pipeline test`
Expected: 全部 passed（import 1 + schema 2 + prompts 3）

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(pipeline): 风物卡写作模板 prompt 与草稿 schema

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: apps/pipeline — AI 生成 CLI（检索 → 成稿 → 入库）

**Files:**
- Create: `apps/pipeline/src/generate.ts`, `apps/pipeline/test/generate.test.ts`

**Interfaces:**
- Consumes: Task 8 的 `buildResearchPrompt` / `buildCardPrompt` / `cardDraftSchema`；`@zhixing/db`
- Produces:
  - `saveDraft(prisma: PrismaClient, placeId: string, category: Category, draft: CardDraft): Promise<Card & { blocks: CardBlock[] }>`（status=AI_GENERATED，blocks 全为 TEXT）
  - CLI：`pnpm --filter @zhixing/pipeline generate -- --place 什刹海 --category ANECDOTE --count 2 [--no-web-search]`
- LLM 用法（遵守 Global Constraints）：模型 `claude-opus-4-8`；两步调用——①研究：`client.messages.create` + `web_search_20260209`（`max_uses: 3` 控制成本，`--no-web-search` 跳过）；②成稿：`client.messages.parse` + `zodOutputFormat(cardDraftSchema)` 结构化输出

- [ ] **Step 1: 写失败测试（不调真实 API，只测入库函数）**

`apps/pipeline/test/generate.test.ts`:
```ts
import { afterAll, beforeEach, expect, test } from "vitest";
import { createPrisma } from "@zhixing/db";
import { saveDraft } from "../src/generate.js";

const prisma = createPrisma(
  process.env.TEST_DATABASE_URL ?? "postgresql://zhixing:zhixing@localhost:5432/zhixing_test",
);

beforeEach(async () => {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "FootprintPhoto","Footprint","CardBlock","Card","Place","User","SearchMiss" RESTART IDENTITY CASCADE',
  );
});
afterAll(async () => prisma.$disconnect());

test("草稿入库为 AI_GENERATED，块序与来源正确", async () => {
  const place = await prisma.place.create({
    data: { name: "什刹海", level: "DISTRICT", lat: 39.94, lng: 116.383 },
  });
  const card = await saveDraft(prisma, place.id, "ANECDOTE", {
    title: "银锭观山",
    blocks: [
      { type: "text", content: "a".repeat(60) },
      { type: "text", content: "b".repeat(60) },
    ],
    sources: ["《燕都游览志》"],
  });
  expect(card.status).toBe("AI_GENERATED");
  expect(card.blocks.map((b) => b.order)).toEqual([0, 1]);
  expect(card.blocks.every((b) => b.type === "TEXT")).toBe(true);
  expect(card.sources).toEqual(["《燕都游览志》"]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @zhixing/pipeline test`
Expected: generate 测试 FAIL（模块不存在）

- [ ] **Step 3: 写实现**

`apps/pipeline/src/generate.ts`:
```ts
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { createPrisma, type Card, type CardBlock, type PrismaClient } from "@zhixing/db";
import { buildCardPrompt, buildResearchPrompt, CATEGORY_LABELS, type Category } from "./prompts.js";
import { cardDraftSchema, type CardDraft } from "./schema.js";

const MODEL = process.env.ZHIXING_GEN_MODEL ?? "claude-opus-4-8";

async function research(
  client: Anthropic,
  placeName: string,
  cityName: string,
  category: Category,
): Promise<string> {
  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    thinking: { type: "adaptive" },
    tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }],
    messages: [{ role: "user", content: buildResearchPrompt(placeName, cityName, category) }],
  });
  return res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

async function writeCard(
  client: Anthropic,
  opts: Parameters<typeof buildCardPrompt>[0],
): Promise<CardDraft> {
  const res = await client.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { format: zodOutputFormat(cardDraftSchema) },
    messages: [{ role: "user", content: buildCardPrompt(opts) }],
  });
  if (!res.parsed_output) throw new Error(`structured output 解析失败 (stop_reason=${res.stop_reason})`);
  return res.parsed_output;
}

export async function saveDraft(
  prisma: PrismaClient,
  placeId: string,
  category: Category,
  draft: CardDraft,
): Promise<Card & { blocks: CardBlock[] }> {
  return prisma.card.create({
    data: {
      placeId,
      category,
      title: draft.title,
      status: "AI_GENERATED",
      sources: draft.sources,
      blocks: {
        create: draft.blocks.map((b, i) => ({ order: i, type: "TEXT", text: b.content })),
      },
    },
    include: { blocks: { orderBy: { order: "asc" } } },
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      place: { type: "string" },
      category: { type: "string" },
      count: { type: "string", default: "1" },
      "no-web-search": { type: "boolean", default: false },
    },
  });
  const categories = Object.keys(CATEGORY_LABELS) as Category[];
  if (!values.place || !values.category || !categories.includes(values.category as Category)) {
    console.error(
      `用法: pnpm --filter @zhixing/pipeline generate -- --place <地点名> --category <${categories.join("|")}> [--count N] [--no-web-search]`,
    );
    process.exit(1);
  }
  const category = values.category as Category;
  const count = Number(values.count);

  const prisma = createPrisma(process.env.DATABASE_URL);
  const client = new Anthropic(); // 凭据自动解析：ANTHROPIC_API_KEY 或 ant auth profile
  try {
    const place = await prisma.place.findFirst({
      where: { name: values.place },
      include: { parent: true },
    });
    if (!place) throw new Error(`地点不存在: ${values.place}（先运行 import-places 或在后台创建）`);
    const cityName = place.parent?.name ?? place.name;

    for (let i = 0; i < count; i++) {
      const existing = await prisma.card.findMany({
        where: { placeId: place.id, status: { not: "RETIRED" } },
        select: { title: true },
      });
      const existingTitles = existing.map((c) => c.title);

      const notes = values["no-web-search"]
        ? null
        : await research(client, place.name, cityName, category);
      const draft = await writeCard(client, {
        placeName: place.name,
        cityName,
        category,
        notes,
        existingTitles,
      });
      const card = await saveDraft(prisma, place.id, category, draft);
      console.log(`✓ [${CATEGORY_LABELS[category]}] ${card.title} (${card.id})`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @zhixing/pipeline test`
Expected: 全部 passed（import 1 + schema 2 + prompts 3 + generate 1）

- [ ] **Step 5: Live 冒烟（需要凭据；无凭据则跳过并在验收时补）**

先确认凭据：`echo ${ANTHROPIC_API_KEY:+set}` 非空，或 `ant auth status` 显示活跃 profile。

Run: `export DATABASE_URL=postgresql://zhixing:zhixing@localhost:5432/zhixing && pnpm --filter @zhixing/pipeline generate -- --place 什刹海 --category ANECDOTE --count 1`
Expected: 输出 `✓ [掌故] <标题> (<id>)`；随后 `docker compose exec -T db psql -U zhixing -d zhixing -c "select title,status from \"Card\""` 能看到该卡，status=AI_GENERATED

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(pipeline): AI 风物卡生成 CLI（web 检索+结构化成稿+入库）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: M0 端到端验收

**Files:**
- 无新代码；只执行与打标签

**Interfaces:**
- Consumes: 全部前序任务
- Produces: 通过规格书 M0 过关标准的运行系统 + git tag `m0`

- [ ] **Step 1: 全量测试与构建**

Run: `pnpm test && pnpm --filter @zhixing/admin build`
Expected: 所有包测试通过；admin 构建成功

- [ ] **Step 2: 起服务并灌数据**

Run:
```bash
docker compose up -d db
export DATABASE_URL=postgresql://zhixing:zhixing@localhost:5432/zhixing
pnpm --filter @zhixing/pipeline import-places
pnpm --filter @zhixing/api dev &   # 或单独终端
pnpm --filter @zhixing/admin dev & # 或单独终端
```
Expected: API :8787 / admin :3000 运行；`curl -s localhost:8787/places | head -c 200` 能看到北京地点

- [ ] **Step 3: 批量生成 10+ 张卡（M0 过关标准）**

Run:
```bash
for c in ANECDOTE FOOD CUSTOMS PLACE_NAME DIALECT; do
  pnpm --filter @zhixing/pipeline generate -- --place 什刹海 --category $c --count 1
done
for c in ANECDOTE FOOD CUSTOMS PLACE_NAME DIALECT; do
  pnpm --filter @zhixing/pipeline generate -- --place 大栅栏 --category $c --count 1
done
```
Expected: 10 行 `✓ ...`；`docker compose exec -T db psql -U zhixing -d zhixing -c "select count(*) from \"Card\""` ≥ 10

- [ ] **Step 4: 后台复核流程走通**

浏览器 http://localhost:3000/cards → 选「什刹海」→ 打开任一卡 → 通读内容（检查写作规则遵守情况：非百科腔开头、有细节锚点、来源非空）→ 点「标记已复核」→ 状态变 REVIEWED；另挑一张点「下架」→ 从列表消失。
Expected: 全部操作成功，无控制台报错

- [ ] **Step 5: 打标签与提交**

```bash
git add -A && git commit -m "chore: M0 地基验收通过（管线批量产卡+后台复核闭环）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>" --allow-empty
git tag m0
```

---

## 范围外（后续计划）

- **iOS App 骨架**（M1，需 macOS/Xcode，另出计划）；足迹/照片/用户 API 路由（M1）；对象存储与图片上传（M1）；风物卡配图生产（M0 卡片先纯文字，配图在复核时后台补传——PATCH blocks 已支持 IMAGE 块）；选题清单工作流（M0 由 generate 按分类直接成稿+标题去重兜底，规格书 §3.1 的"人工挑选题"在 M1 后台补）；SearchMiss 记录接口（M1 搜索功能一并做）；UGC 审核队列与报错处理后台页（M2，随公开分享功能一并做——规格书 §4.3）
