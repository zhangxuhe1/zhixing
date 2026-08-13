# 网友分享更名与外链内容标签实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 地点抽屉第二分栏「网友攻略」更名「网友分享」；新增管理端自主维护的外链内容标签（字典表 `PlaceLinkTag` + `PlaceLink.tagId` 可空外键），管理后台可增删改标签并给每条外链打标，App 端链接行渲染标签 chip，用户点开前一眼看出内容类型（实用攻略 / 旅行记录 / …）。顺带修复存量 URL 首尾空白的数据质量问题。

**Architecture:** DB 加一张字典表和一个可空 FK（`onDelete: Restrict` 防误删丢标注）；API 新增 `/admin/link-tags` CRUD 与两个管理端读取接口（`GET /admin/places/:id/links`、`GET /admin/links`），公开 `/places/:id` 的 links DTO 逐字段加 `tag: string | null`（仅标签名）；管理端加标签管理页与外链总览页、地点外链页加标签列；iOS `PlaceLink` 加可选 `tag` 字段并渲染安静 chip。无 capability 协商、无回填 CLI——存量 79 条上线后人工在后台打标。

**Tech Stack:** Prisma / Fastify 5 + zod / Next.js 15 App Router / SwiftUI（iOS 17+）。测试打真库（zhixing_test + MinIO），管理端无自动化测试基建，走 build + 人工走查。

**Spec:** docs/superpowers/specs/2026-08-12-place-link-tags-design.md

## Global Constraints

- 在当前功能分支上实施；不得把无关工作区改动混进提交。
- **每个任务提交前先 `git status --short` 核对：暂存区只含该任务 Files 列出的路径**——`git commit` 提交的是整个 index，不只是刚 `git add` 的文件。两份方案文档在 Implementation Kickoff 单独成 commit，绝不混进任何 feat 提交。
- **每个 shell 代码块自包含**：不依赖上一个代码块导出的变量或遗留的 cwd，全部从仓库根执行；需要变量的块在块内自行声明，需要切目录的用子 shell `( cd … )` 包裹。
- ESM + TS strict + NodeNext：相对导入带 `.js` 后缀。错误形状统一 `{ error, detail? }`，body 校验全走 zod，失败 400 `invalid_body`。
- 注释/文档/commit 一律中文，conventional commits。
- 测试打真库：先 `pnpm db:up`；**Task 1 之后必须 `pnpm -C packages/db push:test`**，否则测试库缺表缺列、api 套件全线假红。
- **新表 `PlaceLinkTag` 必须加进全部含 `"PlaceLink"` 的 TRUNCATE 清单（8 个文件，Task 1 列明）**，否则脏数据假失败。
- 公开 DTO 逐字段组装，禁字段（userId/appleSub/lat/lng/精确 takenAt/email/subject）零新增泄漏；本次还要保证公开面不泄漏 `tagId/placeId/createdAt`。
- 每个 api 任务收尾跑 `pnpm -C apps/api exec vitest run` 全绿再提交；iOS 任务收尾跑 `scripts/ios-test.sh`（内置 `xcodegen generate`；模拟器偶发 Busy 瞬态失败重跑即过）。本计划无新增 iOS 源文件，project.yml 不动。
- 部署顺序（写进认知，不是本地步骤）：DB migration → API → 管理端；老 API 对新列/新表零感知，回滚只回二进制、保留数据。

## Dependency Order

Implementation Kickoff → Task 1（DB）→ Task 2（标签字典 API）→ Task 3(外链打标 API) → Task 4（管理端）与 Task 5（iOS）可并行 → Task 6（文档 + 全链路回归收尾）。

---

## Implementation Kickoff

- [x] **两份方案文档先单独成 commit**（此时 `git status --short` 应只显示这两个路径与已删除的旧方案文档；若有其它暂存内容先处理干净）：

```sh
git add docs/superpowers/specs/2026-08-12-place-link-tags-design.md docs/superpowers/plans/2026-08-12-place-link-tags.md
git status --short   # 核对:暂存区只有本次方案文档(含旧方案文档的删除)
git commit -m "docs(spec): 网友分享更名与外链内容标签方案

以管理端自主维护的标签字典取代旧的 kind 枚举方案(旧 spec/plan 一并移除)。"
```

---

### Task 1: PlaceLinkTag 表、tagId 外键与存量 URL 清洗

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/prisma/migrations/<timestamp>_place_link_tag/migration.sql`（migrate dev 生成后手工追加一条 UPDATE）
- Modify（TRUNCATE 清单 8 处）: `apps/api/test/helpers.ts`、`packages/db/test/identity.test.ts`、`packages/db/test/schema.test.ts`、`packages/db/test/seed.test.ts`、`packages/db/test/seed-extras.test.ts`、`packages/db/test/m2-models.test.ts`、`apps/pipeline/test/import.test.ts`、`apps/pipeline/test/regions.test.ts`
- Test: `packages/db/test/schema.test.ts`

- [x] **Step 1: schema 变更**

`packages/db/prisma/schema.prisma` 中 `PlaceLink` 模型之前插入：

```prisma
// 外链内容标签字典:管理端自由增删改(如"实用攻略""旅行记录"),重命名即时全局生效。
// 删除被引用标签由 API 预检 + FK Restrict 双层拒绝,防误删丢标注。
// 详见 docs/superpowers/specs/2026-08-12-place-link-tags-design.md
model PlaceLinkTag {
  id        String      @id @default(cuid())
  name      String      @unique
  sortOrder Int         @default(0) // 下拉选项与列表展示顺序
  links     PlaceLink[]
  createdAt DateTime    @default(now())
}
```

`PlaceLink` 在 `sortOrder` 与 `createdAt` 之间加两行：

```prisma
  tagId     String?
  tag       PlaceLinkTag? @relation(fields: [tagId], references: [id], onDelete: Restrict)
```

- [x] **Step 2: 生成迁移（--create-only）并追加存量 URL 清洗**

prisma CLI 不读仓库根 `.env`（那是 api/pipeline 运行时的加载约定），必须显式绑定数据库 URL。**本计划每个代码块自包含：不依赖上一个块导出的变量或遗留的 cwd**，全部命令从仓库根、以内联 env 执行。

```sh
DATABASE_URL="postgresql://zhixing:zhixing@127.0.0.1:5433/zhixing" \
  pnpm --filter @zhixing/db exec prisma migrate dev --create-only --name place_link_tag
```

在生成的 `migration.sql` 末尾追加（幂等；2026-08 实测现网 21 条抖音短链带尾随空白，入口 trim 见 Task 3）：

```sql
-- 存量 URL 首尾空白一次性清洗(无判断的规范化,允许进 migration;业务打标不进)
UPDATE "PlaceLink" SET "url" = btrim("url", E' \t\r\n') WHERE "url" <> btrim("url", E' \t\r\n');
```

- [x] **Step 3: 一次性演练库验证「旧结构 + 存量脏 URL → 目标迁移」（可反复重跑；push:test 绕过 migration SQL，不能替代本步）**

整块自包含、`set -e` fail-closed、开头即重建演练库——中途失败直接重跑整块即可，不碰开发库/测试库，也不会留下「已半途迁移无法复验」的状态。两次 `migrate deploy` 用的正是生产升级的同一命令与同一份 SQL 文件：

```sh
set -euo pipefail
CHECK_DB="zhixing_migration_check"
CHECK_URL="postgresql://zhixing:zhixing@127.0.0.1:5433/${CHECK_DB}"
MIG_DIR=$(ls -d packages/db/prisma/migrations/*_place_link_tag)
STASH=$(mktemp -d)   # 每次运行独立暂存目录:不受上次异常残留或 /tmp 同名无关文件污染
MOVED=0
# 仅在"确实已移出且尚未放回"(MOVED=1 且原目录不存在)时恢复:早期失败(如 Docker 未启动)
# 不会把无关内容塞进迁移目录,正常放回后也不会二次移动;两条路径都清掉暂存目录
trap 'if [ "$MOVED" = "1" ] && [ ! -e "$MIG_DIR" ]; then mv "$STASH/mig" "$MIG_DIR"; fi; rm -rf "$STASH"' EXIT

# 1) 重建一次性演练库(幂等,可反复执行)
docker compose exec -T db psql -U zhixing -d postgres -c "DROP DATABASE IF EXISTS ${CHECK_DB};"
docker compose exec -T db psql -U zhixing -d postgres -c "CREATE DATABASE ${CHECK_DB};"

# 2) 暂时移出新迁移,把演练库 deploy 到"旧结构"边界
mv "$MIG_DIR" "$STASH/mig"; MOVED=1
DATABASE_URL="$CHECK_URL" pnpm --filter @zhixing/db exec prisma migrate deploy
mv "$STASH/mig" "$MIG_DIR"; MOVED=0

# 3) 旧结构下种一条带首尾空白的存量脏 URL(等价生产升级前置状态)
docker compose exec -T db psql -U zhixing "$CHECK_DB" -c "
INSERT INTO \"Place\" (\"id\",\"name\",\"level\",\"lat\",\"lng\") VALUES ('mig-check-place','迁移校验点','POI',0,0);
INSERT INTO \"PlaceLink\" (\"id\",\"placeId\",\"platform\",\"title\",\"url\") VALUES ('mig-check-link','mig-check-place','DOUYIN','迁移校验',' https://v.douyin.com/mig ');"

# 4) 生产同款 migrate deploy 应用目标迁移
DATABASE_URL="$CHECK_URL" pnpm --filter @zhixing/db exec prisma migrate deploy

# 5) 机器断言:URL 已清洗且默认未打标(grep -qx 不匹配即非零退出,set -e 中止)
docker compose exec -T db psql -U zhixing "$CHECK_DB" -tA -c \
  "SELECT (\"url\" = 'https://v.douyin.com/mig') AND (\"tagId\" IS NULL) FROM \"PlaceLink\" WHERE \"id\" = 'mig-check-link';" \
  | grep -qx t

# 6) 销毁演练库
docker compose exec -T db psql -U zhixing -d postgres -c "DROP DATABASE IF EXISTS ${CHECK_DB};"
echo "migration rehearsal OK"
```

Expected: 输出 `migration rehearsal OK`；`migration.sql` 含 `CREATE TABLE "PlaceLinkTag"`、`ALTER TABLE "PlaceLink" ADD COLUMN "tagId"`、`ON DELETE RESTRICT` 外键与 UPDATE。（psql 服务名以本地 compose 为准，`docker compose ps` 可查。）

- [x] **Step 4: 应用迁移到开发库**

```sh
DATABASE_URL="postgresql://zhixing:zhixing@127.0.0.1:5433/zhixing" \
  pnpm --filter @zhixing/db exec prisma migrate dev
```

Expected: 迁移应用成功（也会重新 `prisma generate`）。

- [x] **Step 5: 八处 TRUNCATE 清单补 `"PlaceLinkTag"`**

上列 8 个文件的 TRUNCATE 语句中，在 `"PlaceLink"` 后插入 `,"PlaceLinkTag"`。例（apps/api/test/helpers.ts）：

```ts
    'TRUNCATE TABLE "Like","FootprintPhoto","Footprint","Trip","CardFavorite","CardReport","CardBlock","Card","PlaceLink","PlaceLinkTag","Place","User","Identity","EmailCode","SearchMiss" RESTART IDENTITY CASCADE',
```

改完用 `rg '"PlaceLink"' -l --glob '*.ts'` 复核：所有命中文件都应同时含 `"PlaceLinkTag"`（`apps/pipeline/test/generate.test.ts` 的清单本就不含 PlaceLink，不动）。

- [x] **Step 6: 同步测试库**

```sh
pnpm -C packages/db push:test
```

`push:test` 用 `db push` 按 schema 直接建表（绕过 migration SQL）——btrim 清洗已在 Step 3 经真实迁移验证，此处只负责测试库结构同步。

- [x] **Step 7: 往返测试**

`packages/db/test/schema.test.ts` 末尾追加：

```ts
test("PlaceLinkTag 往返:挂标、重名拒绝、删除被引用标签拒绝", async () => {
  const place = await prisma.place.create({
    data: { name: "香港", level: "CITY", lat: 22.32, lng: 114.17 },
  });
  const tag = await prisma.placeLinkTag.create({ data: { name: "实用攻略" } });
  await prisma.placeLink.create({
    data: {
      placeId: place.id, platform: "BILIBILI",
      title: "200 元穷游香港", url: "https://example.com/hk", tagId: tag.id,
    },
  });
  const read = await prisma.placeLink.findFirstOrThrow({ include: { tag: true } });
  expect(read.tag?.name).toBe("实用攻略");

  // name 唯一约束
  await expect(prisma.placeLinkTag.create({ data: { name: "实用攻略" } })).rejects.toThrow();
  // onDelete: Restrict——被引用标签不可删
  await expect(prisma.placeLinkTag.delete({ where: { id: tag.id } })).rejects.toThrow();
  // 地点级联删链接后,标签才可删
  await prisma.place.delete({ where: { id: place.id } });
  await prisma.placeLinkTag.delete({ where: { id: tag.id } });
  expect(await prisma.placeLinkTag.count()).toBe(0);
});
```

- [x] **Step 8: 跑 db 与全仓测试**

```sh
pnpm -C packages/db exec vitest run && pnpm test
```

Expected: PASS（全仓绿——确认 TRUNCATE 无遗漏、老代码对新列零感知）。

- [x] **Step 9: 提交**

```sh
git add packages/db/prisma packages/db/test apps/api/test/helpers.ts apps/pipeline/test/import.test.ts apps/pipeline/test/regions.test.ts
git commit -m "feat(db): PlaceLink 标签字典表与存量 URL 清洗

新增 PlaceLinkTag(管理端自主增删改的外链内容标签)与 PlaceLink.tagId 可空外键
(onDelete Restrict 防误删丢标注);migration 附带存量 URL 首尾空白 btrim 清洗。
spec: docs/superpowers/specs/2026-08-12-place-link-tags-design.md"
```

---

### Task 2: 标签字典管理接口 /admin/link-tags

**Files:**
- Create: `apps/api/src/routes/adminLinkTags.ts`
- Modify: `apps/api/src/app.ts`（import + register，插在 `adminPlacesRoutes` 之后）
- Test: `apps/api/test/adminLinkTags.test.ts`（新建）

**Interfaces:**
- Produces: `GET /admin/link-tags` → `[{ id, name, sortOrder, linkCount }]`；`POST /admin/link-tags`；`PATCH /admin/link-tags/:id`；`DELETE /admin/link-tags/:id`。全部 `requireAdmin`。

- [x] **Step 1: 先写失败的测试**

新建 `apps/api/test/adminLinkTags.test.ts`：

```ts
import { afterAll, beforeEach, expect, test } from "vitest";
import { ADMIN_AUTH, resetDb, testApp } from "./helpers.js";

const app = testApp();
beforeEach(() => resetDb(app));
afterAll(async () => app.close());

async function makeTag(name: string, sortOrder?: number) {
  const res = await app.inject({
    method: "POST", url: "/admin/link-tags", headers: ADMIN_AUTH,
    payload: { name, ...(sortOrder !== undefined ? { sortOrder } : {}) },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; name: string; sortOrder: number; linkCount: number };
}

test("标签全部端点需要 admin", async () => {
  for (const req of [
    { method: "GET" as const, url: "/admin/link-tags" },
    { method: "POST" as const, url: "/admin/link-tags", payload: { name: "x" } },
    { method: "PATCH" as const, url: "/admin/link-tags/x", payload: { name: "x" } },
    { method: "DELETE" as const, url: "/admin/link-tags/x" },
  ]) {
    expect((await app.inject(req)).statusCode).toBe(401);
  }
});

test("新增/列表按 sortOrder;重名与改名撞重名 409", async () => {
  const guide = await makeTag("实用攻略", 0);
  await makeTag("旅行记录", 1);

  const dup = await app.inject({
    method: "POST", url: "/admin/link-tags", headers: ADMIN_AUTH, payload: { name: "实用攻略" },
  });
  expect(dup.statusCode).toBe(409);
  expect(dup.json().error).toBe("duplicate_name");

  const renamed = await app.inject({
    method: "PATCH", url: `/admin/link-tags/${guide.id}`, headers: ADMIN_AUTH,
    payload: { name: "攻略" },
  });
  expect(renamed.statusCode).toBe(200);
  expect(renamed.json().name).toBe("攻略");

  const clash = await app.inject({
    method: "PATCH", url: `/admin/link-tags/${guide.id}`, headers: ADMIN_AUTH,
    payload: { name: "旅行记录" },
  });
  expect(clash.statusCode).toBe(409);

  const list = await app.inject({ method: "GET", url: "/admin/link-tags", headers: ADMIN_AUTH });
  expect(list.json().map((t: { name: string }) => t.name)).toEqual(["攻略", "旅行记录"]);
  expect(list.json()[0].linkCount).toBe(0);
});

test("空名/纯空白/超长名 400;PATCH 空对象 400;不存在 404", async () => {
  for (const name of ["", "   ", "一二三四五六七八九十一二三"]) {
    const res = await app.inject({
      method: "POST", url: "/admin/link-tags", headers: ADMIN_AUTH, payload: { name },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_body");
  }
  const tag = await makeTag("攻略");
  const empty = await app.inject({
    method: "PATCH", url: `/admin/link-tags/${tag.id}`, headers: ADMIN_AUTH, payload: {},
  });
  expect(empty.statusCode).toBe(400);
  const missing = await app.inject({
    method: "PATCH", url: "/admin/link-tags/nope", headers: ADMIN_AUTH, payload: { name: "x" },
  });
  expect(missing.statusCode).toBe(404);
});

test("删除:未引用 204;被引用 409 tag_in_use 且带计数", async () => {
  const tag = await makeTag("攻略");
  const place = await app.prisma.place.create({
    data: { name: "香港", level: "CITY", lat: 22.32, lng: 114.17 },
  });
  await app.prisma.placeLink.create({
    data: { placeId: place.id, platform: "BILIBILI", title: "x", url: "https://e.com/a", tagId: tag.id },
  });
  const inUse = await app.inject({
    method: "DELETE", url: `/admin/link-tags/${tag.id}`, headers: ADMIN_AUTH,
  });
  expect(inUse.statusCode).toBe(409);
  expect(inUse.json()).toEqual({ error: "tag_in_use", detail: { linkCount: 1 } });

  await app.prisma.placeLink.deleteMany({});
  const ok = await app.inject({
    method: "DELETE", url: `/admin/link-tags/${tag.id}`, headers: ADMIN_AUTH,
  });
  expect(ok.statusCode).toBe(204);
  expect(await app.prisma.placeLinkTag.count()).toBe(0);
});
```

Run: `pnpm -C apps/api exec vitest run test/adminLinkTags.test.ts` → Expected: **FAIL**（404，路由不存在）。

- [x] **Step 2: 实现路由**

新建 `apps/api/src/routes/adminLinkTags.ts`：

```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@zhixing/db";
import { requireAdmin } from "../auth.js";

// name 上限 12 字:iOS 行内 chip 与管理端下拉的展示宽度约束
const tagCreateSchema = z.object({
  name: z.string().trim().min(1).max(12),
  sortOrder: z.number().int().min(0).optional(),
});

const tagPatchSchema = tagCreateSchema.partial().refine(
  (v) => Object.values(v).some((x) => x !== undefined),
  { message: "at least one field required" },
);

const TAG_DTO = { id: true, name: true, sortOrder: true } as const;

// 外链内容标签字典:运营自主增删改,免发版扩展分类。删除被引用标签在预检
// 与 FK Restrict(P2003)两层都收敛为 409,防误删静默丢标注。
export async function adminLinkTagsRoutes(app: FastifyInstance) {
  app.get("/admin/link-tags", { preHandler: requireAdmin }, async () => {
    const tags = await app.prisma.placeLinkTag.findMany({
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: { ...TAG_DTO, _count: { select: { links: true } } },
    });
    return tags.map(({ _count, ...t }) => ({ ...t, linkCount: _count.links }));
  });

  app.post("/admin/link-tags", { preHandler: requireAdmin }, async (req, reply) => {
    const body = tagCreateSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    }
    try {
      const tag = await app.prisma.placeLinkTag.create({ data: body.data, select: TAG_DTO });
      return reply.code(201).send({ ...tag, linkCount: 0 });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return reply.code(409).send({ error: "duplicate_name" });
      }
      throw err;
    }
  });

  app.patch("/admin/link-tags/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = tagPatchSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_body", detail: body.error.flatten() });
    }
    const existing = await app.prisma.placeLinkTag.findUnique({ where: { id }, select: { id: true } });
    if (!existing) return reply.code(404).send({ error: "not_found" });
    try {
      return await app.prisma.placeLinkTag.update({ where: { id }, data: body.data, select: TAG_DTO });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return reply.code(409).send({ error: "duplicate_name" });
      }
      throw err;
    }
  });

  app.delete("/admin/link-tags/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await app.prisma.placeLinkTag.findUnique({
      where: { id }, select: { _count: { select: { links: true } } },
    });
    if (!existing) return reply.code(404).send({ error: "not_found" });
    if (existing._count.links > 0) {
      return reply.code(409).send({ error: "tag_in_use", detail: { linkCount: existing._count.links } });
    }
    try {
      await app.prisma.placeLinkTag.delete({ where: { id } });
    } catch (err) {
      // 预检与删除之间被并发打标:FK Restrict 兜底,同样收敛为 409
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
        return reply.code(409).send({ error: "tag_in_use" });
      }
      throw err;
    }
    return reply.code(204).send();
  });
}
```

`apps/api/src/app.ts`：import `adminLinkTagsRoutes`（保持字母序位置），在 `app.register(adminPlacesRoutes);` 之后加 `app.register(adminLinkTagsRoutes);`。

- [x] **Step 3: 跑测试与全量回归**

```sh
pnpm -C apps/api exec vitest run test/adminLinkTags.test.ts && pnpm -C apps/api exec vitest run
```

Expected: 全绿。

- [x] **Step 4: 提交**

```sh
git add apps/api/src/routes/adminLinkTags.ts apps/api/src/app.ts apps/api/test/adminLinkTags.test.ts
git commit -m "feat(api): 外链标签字典管理接口

/admin/link-tags CRUD(requireAdmin):列表带引用计数,重名 409,
删除被引用标签预检+FK Restrict 双层拒绝(409 tag_in_use)。
spec: docs/superpowers/specs/2026-08-12-place-link-tags-design.md"
```

---

### Task 3: 外链打标、公开 tag 投影与管理端读取接口

**Files:**
- Create: `apps/api/src/placeLinks.ts`（共享排序常量与 LINK_SELECT）
- Modify: `apps/api/src/routes/adminPlaces.ts`（schema 加 tagId/url trim、LINK_SELECT 迁出、tagId 预检、新增两个 GET）
- Modify: `apps/api/src/routes/places.ts`（公开 DTO 加 tag、排序换共享常量）
- Test: `apps/api/test/placeLinks.test.ts`

**Interfaces:**
- Produces: `GET /admin/places/:id/links` → `{ id, name, level, ancestors, links: [{ …LINK_SELECT, tag: { id, name } | null }] }`；`GET /admin/links` → `{ items: [{ …, place: { id, path } }] }`；公开 `/places/:id` links 项新增 `tag: string | null`。
- Consumes: `placeAncestors`（src/placeAncestors.ts）、Task 2 的标签表。

- [x] **Step 1: 先改/加测试（失败）**

`apps/api/test/placeLinks.test.ts`：

① 既有键断言（约 :39）改为——这是逐字段 DTO 防护按预期报警，不是回归：

```ts
  expect(Object.keys(detail.json().links[0]).sort()).toEqual(
    ["id", "platform", "sortOrder", "tag", "title", "url"].sort(),
  );
```

② 文件末尾追加：

```ts
test("打标:POST/PATCH tagId;公开详情投影标签名;未知 tagId 400", async () => {
  const place = await makePlace();
  const tag = await app.prisma.placeLinkTag.create({ data: { name: "实用攻略" } });

  const created = await app.inject({
    method: "POST", url: `/admin/places/${place.id}/links`, headers: ADMIN_AUTH,
    payload: { platform: "BILIBILI", title: "200 元穷游香港", url: "https://example.com/hk", tagId: tag.id, sortOrder: 0 },
  });
  expect(created.statusCode).toBe(201);
  expect(created.json().tag).toEqual({ id: tag.id, name: "实用攻略" });

  const untagged = await app.inject({
    method: "POST", url: `/admin/places/${place.id}/links`, headers: ADMIN_AUTH,
    payload: { platform: "DOUYIN", title: "香港旅行记录", url: "https://example.com/hk2", sortOrder: 1 },
  });
  expect(untagged.json().tag).toBeNull();

  // 公开详情:已打标 → 标签名字符串;未打标 → null;全文不泄漏 tagId
  const detail = await app.inject({ method: "GET", url: `/places/${place.id}` });
  expect(detail.json().links.map((l: { tag: string | null }) => l.tag)).toEqual(["实用攻略", null]);
  expect(detail.body).not.toContain("tagId");

  // PATCH 取消标签;未知 tagId 400
  const linkId = created.json().id as string;
  const cleared = await app.inject({
    method: "PATCH", url: `/admin/links/${linkId}`, headers: ADMIN_AUTH, payload: { tagId: null },
  });
  expect(cleared.statusCode).toBe(200);
  expect(cleared.json().tag).toBeNull();

  const unknown = await app.inject({
    method: "PATCH", url: `/admin/links/${linkId}`, headers: ADMIN_AUTH, payload: { tagId: "nope" },
  });
  expect(unknown.statusCode).toBe(400);
  expect(unknown.json().error).toBe("unknown_tag");

  const unknownCreate = await app.inject({
    method: "POST", url: `/admin/places/${place.id}/links`, headers: ADMIN_AUTH,
    payload: { platform: "OTHER", title: "x", url: "https://example.com/x", tagId: "nope" },
  });
  expect(unknownCreate.statusCode).toBe(400);
  expect(unknownCreate.json().error).toBe("unknown_tag");
});

test("URL 首尾空白 trim 落库;trim 后非法仍 400", async () => {
  const place = await makePlace();
  const res = await app.inject({
    method: "POST", url: `/admin/places/${place.id}/links`, headers: ADMIN_AUTH,
    payload: { platform: "DOUYIN", title: "短链", url: " https://v.douyin.com/abc " },
  });
  expect(res.statusCode).toBe(201);
  expect(res.json().url).toBe("https://v.douyin.com/abc");
  expect((await app.prisma.placeLink.findFirstOrThrow()).url).toBe("https://v.douyin.com/abc");

  const bad = await app.inject({
    method: "POST", url: `/admin/places/${place.id}/links`, headers: ADMIN_AUTH,
    payload: { platform: "DOUYIN", title: "x", url: "   " },
  });
  expect(bad.statusCode).toBe(400);
});

test("GET /admin/places/:id/links:401/404/与公开详情同序", async () => {
  const place = await makePlace();
  expect((await app.inject({ method: "GET", url: `/admin/places/${place.id}/links` })).statusCode).toBe(401);
  expect((await app.inject({
    method: "GET", url: "/admin/places/nope/links", headers: ADMIN_AUTH,
  })).statusCode).toBe(404);

  // 相同 sortOrder 下按创建先后稳定排序,且与公开详情同序
  for (const title of ["第一条", "第二条"]) {
    await app.inject({
      method: "POST", url: `/admin/places/${place.id}/links`, headers: ADMIN_AUTH,
      payload: { platform: "OTHER", title, url: `https://example.com/${title}` },
    });
  }
  const admin = await app.inject({
    method: "GET", url: `/admin/places/${place.id}/links`, headers: ADMIN_AUTH,
  });
  expect(admin.statusCode).toBe(200);
  expect(admin.json().name).toBe("什刹海");
  expect(Array.isArray(admin.json().ancestors)).toBe(true);
  const adminIds = admin.json().links.map((l: { id: string }) => l.id);
  const publicIds = (await app.inject({ method: "GET", url: `/places/${place.id}` }))
    .json().links.map((l: { id: string }) => l.id);
  expect(adminIds).toEqual(publicIds);
  expect(admin.json().links.map((l: { title: string }) => l.title)).toEqual(["第一条", "第二条"]);
});

test("GET /admin/links:401/全量含地点路径与标签", async () => {
  expect((await app.inject({ method: "GET", url: "/admin/links" })).statusCode).toBe(401);

  const province = await app.prisma.place.create({
    data: { name: "北京市", level: "PROVINCE", lat: 39.9, lng: 116.4 },
  });
  const poi = await app.prisma.place.create({
    data: { name: "什刹海", level: "DISTRICT", parentId: province.id, lat: 39.94, lng: 116.38 },
  });
  const tag = await app.prisma.placeLinkTag.create({ data: { name: "旅行记录" } });
  await app.prisma.placeLink.create({
    data: { placeId: poi.id, platform: "DOUYIN", title: "漫步", url: "https://e.com/a", tagId: tag.id },
  });
  await app.prisma.placeLink.create({
    data: { placeId: province.id, platform: "BILIBILI", title: "未打标", url: "https://e.com/b" },
  });

  const res = await app.inject({ method: "GET", url: "/admin/links", headers: ADMIN_AUTH });
  expect(res.statusCode).toBe(200);
  const items = res.json().items as {
    title: string; tag: { name: string } | null; place: { id: string; path: string };
  }[];
  expect(items).toHaveLength(2);
  const walk = items.find((i) => i.title === "漫步")!;
  expect(walk.place.path).toBe("北京市 · 什刹海");
  expect(walk.tag?.name).toBe("旅行记录");
  expect(items.find((i) => i.title === "未打标")!.tag).toBeNull();
});
```

Run: `pnpm -C apps/api exec vitest run test/placeLinks.test.ts` → Expected: **FAIL**。

- [x] **Step 2: 共享常量模块**

新建 `apps/api/src/placeLinks.ts`：

```ts
import { Prisma } from "@zhixing/db";

// 公开详情与管理端共用的稳定排序:sortOrder 相同(默认 0)时按创建先后,
// createdAt 精度内撞车再按 id 兜底——两侧接口顺序永远一致,不随读取入口漂移。
export const PLACE_LINK_ORDER_BY: Prisma.PlaceLinkOrderByWithRelationInput[] = [
  { sortOrder: "asc" }, { createdAt: "asc" }, { id: "asc" },
];

// 管理端外链 DTO 白名单:标签以 { id, name } 对象下发(编辑需要 id);
// 公开面不用本 select,由 places.ts 逐字段组装并把 tag 投影成纯名字。
export const LINK_SELECT = {
  id: true, platform: true, title: true, url: true, sortOrder: true,
  tag: { select: { id: true, name: true } },
} satisfies Prisma.PlaceLinkSelect;
```

- [x] **Step 3: adminPlaces.ts 改造**

① 顶部 import 补 `placeAncestors`（`../placeAncestors.js`）与共享模块 `PLACE_LINK_ORDER_BY, LINK_SELECT`（`../placeLinks.js`）；删除本文件内旧的 `LINK_SELECT` 常量。

② `linkCreateSchema`：`url` 改 `z.string().trim().url().startsWith("https://").max(500)`，加 `tagId: z.string().nullish()`。`linkPatchSchema` 由 partial 派生自动获得，无需改。

③ POST/PATCH 外链的 handler 在写库前预检标签（并对 P2003 兜底），两处共用小 helper（放在 `linkPatchSchema` 之后）：

```ts
// tagId 预检 + 写库 P2003 兜底都收敛为 400 unknown_tag:
// 预检给出友好错误,FK 兜底覆盖"预检后标签恰被删除"的窄竞态。
async function tagExists(prisma: FastifyInstance["prisma"], tagId: string) {
  return !!(await prisma.placeLinkTag.findUnique({ where: { id: tagId }, select: { id: true } }));
}
```

POST handler 在 `place` 存在性检查后加：

```ts
    if (body.data.tagId && !(await tagExists(app.prisma, body.data.tagId))) {
      return reply.code(400).send({ error: "unknown_tag" });
    }
```

并把 `placeLink.create` 包进 try/catch，P2003 → 400 `unknown_tag`。PATCH handler 同样在 `existing` 检查后预检 + 对 `update` 做同款 P2003 兜底。

④ 新增两个只读接口（放在 DELETE `/admin/links/:id` 之前）：

```ts
  // 管理端地点外链详情:编辑需要 tagId,公开 DTO 只有标签名——管理端不再借公开接口
  app.get("/admin/places/:id/links", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const place = await app.prisma.place.findUnique({
      where: { id },
      include: { links: { select: LINK_SELECT, orderBy: PLACE_LINK_ORDER_BY } },
    });
    if (!place) return reply.code(404).send({ error: "not_found" });
    return {
      id: place.id, name: place.name, level: place.level,
      ancestors: await placeAncestors(app.prisma, place.parentId),
      links: place.links,
    };
  });

  // 外链总览:存量打标与日常巡查入口。一次读全量 Place 内存拼路径,
  // 不做逐链接 N+1;当前 79 条/123 地点量级不分页(阈值见 spec"何时重新考虑")。
  app.get("/admin/links", { preHandler: requireAdmin }, async () => {
    const [links, places] = await Promise.all([
      app.prisma.placeLink.findMany({
        select: { ...LINK_SELECT, placeId: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
      app.prisma.place.findMany({ select: { id: true, name: true, parentId: true } }),
    ]);
    const byId = new Map(places.map((p) => [p.id, p]));
    // 沿父链拼"省 · 市 · 地点";10 跳保险丝防脏数据成环(树深 ≤ 4)
    const pathOf = (placeId: string): string => {
      const names: string[] = [];
      let cur = byId.get(placeId);
      for (let hops = 0; cur && hops < 10; hops++) {
        names.unshift(cur.name);
        cur = cur.parentId ? byId.get(cur.parentId) : undefined;
      }
      return names.join(" · ");
    };
    return {
      items: links.map(({ placeId, ...l }) => ({
        ...l, place: { id: placeId, path: pathOf(placeId) },
      })),
    };
  });
```

- [x] **Step 4: places.ts 公开 DTO**

`apps/api/src/routes/places.ts`：import `PLACE_LINK_ORDER_BY`（`../placeLinks.js`）；`/places/:id` 查询改为：

```ts
      include: { links: { orderBy: PLACE_LINK_ORDER_BY, include: { tag: { select: { name: true } } } } },
```

DTO 的 `links` map 改为（公开面只下发标签名，不泄漏 tagId）：

```ts
      links: place.links.map((l) => ({
        id: l.id, platform: l.platform, title: l.title, url: l.url,
        sortOrder: l.sortOrder, tag: l.tag?.name ?? null,
      })),
```

- [x] **Step 5: 跑 api 全量**

```sh
pnpm -C apps/api exec vitest run
```

Expected: 全绿（含 Step 1 的新用例与更新后的键断言）。

- [x] **Step 6: 提交**

```sh
git add apps/api/src/placeLinks.ts apps/api/src/routes/adminPlaces.ts apps/api/src/routes/places.ts apps/api/test/placeLinks.test.ts
git commit -m "feat(api): 外链打标、公开标签投影与管理端读取接口

linkCreateSchema 加 tagId(未知标签 400)与 url trim;公开 /places/:id 的 links
逐字段加 tag(仅标签名,不泄漏 tagId);新增 GET /admin/places/:id/links 与
GET /admin/links(全量含地点路径,内存拼路径无 N+1);公开/管理端共用稳定排序常量。
spec: docs/superpowers/specs/2026-08-12-place-link-tags-design.md"
```

---

### Task 4: 管理端标签管理、外链总览与地点打标

**Files:**
- Create: `apps/admin/app/link-tags/page.tsx`
- Create: `apps/admin/app/links/page.tsx`
- Modify: `apps/admin/app/places/[id]/page.tsx`（整文件重写）
- Modify: `apps/admin/app/layout.tsx`（导航加「外链」）

管理端无自动化测试基建（维持现状），验收 = `pnpm -C apps/admin build` + 人工走查。三个页面沿用仓库现有 plain 风格（table + 原生控件 + `api()` helper）。

**竞态防线（三页共同约定，评审时对照；spec「写操作竞态防线」是权威表述）**：
- **行级互斥**：某行写请求在途时禁用该行全部控件（per-row busy `Set<string>`）——同一行的连续操作被物理串行化；
- **creating 锁**：新增表单提交在途时禁用「添加」——`PlaceLink.url` 无唯一约束，慢网双击的重复创建只能在入口挡；
- **成功写入一律用响应做函数式内存合并**（`setState(prev => ...)`）：打标/改名替换行、删除 filter、新增 append 后按 `sortOrder` 稳定重排（`Array.prototype.sort` 稳定，平序保持既有相对顺序）；
- **不变量：初始加载之后，整页 `load()` 只允许发生在页面级写锁（`syncing`）内**——仅排序成功后（组内真序在服务端 `createdAt`，本地推不出）与任何写失败后回拉。写锁用**引用计数**（`syncCount`）实现：并发触发多次回拉时，最后一个回拉结束（`finally` 保证释放）才解锁——先完成者不得提前放行新写，否则仍在途的旧 GET 可能覆盖锁外新写。锁内发不出新写，「A 行触发的旧 GET 覆盖 B 行新值」失去存在条件；
- **`load()` 原子提交且失败可见**：多 GET 页面先 `await Promise.all` 拿齐全部结果再一起 `setState`，不提交半份快照（不允许「链接更新了、标签列表还是旧的/空的」）；`load()` 不自吞错误——初始加载失败停在错误页，回拉失败由 `reloadLocked` 设置 `error` 后解锁（页面停留在旧快照，刷新自救），调用方不得在回拉完成后再清空 `error`；
- **可编辑输入（排序/改名）改受控组件**（per-row draft state），失败丢弃草稿即复位——禁止 `defaultValue` + key 技巧（PATCH 失败时服务端值不变、key 不变，输入框不会复位）；
- 已知接受的残余：写锁生效前一瞬已在途的另一行写入可能被回拉快照错过——DB 始终正确，仅显示短暂滞后，刷新即齐。不做 mutation queue / loadGeneration / 全局 reconciliation。

- [x] **Step 1: 导航**

`apps/admin/app/layout.tsx` 在 `<Link href="/places">地点库</Link>` 之后加：

```tsx
          <Link href="/links">外链</Link>
```

- [x] **Step 2: 标签管理页**

新建 `apps/admin/app/link-tags/page.tsx`：

```tsx
"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

type TagRow = { id: string; name: string; sortOrder: number; linkCount: number };
// POST/PATCH /admin/link-tags 的响应形状(POST 额外带 linkCount: 0)
type TagDto = { id: string; name: string; sortOrder: number };

// Array.prototype.sort 是稳定排序:平序保持既有相对顺序(≈ 服务端的 createdAt 次序)
const byOrder = (a: TagRow, b: TagRow) => a.sortOrder - b.sortOrder;

export default function LinkTagsPage() {
  const [tags, setTags] = useState<TagRow[] | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [syncCount, setSyncCount] = useState(0); // 页面级写锁引用计数:>0 期间禁用全页写控件
  const [drafts, setDrafts] = useState<Record<string, string>>({}); // 受控草稿,key = `${id}:${field}`
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const syncing = syncCount > 0;

  // load 不自吞错误:失败向上抛,由初始 effect / reloadLocked 决定如何呈现
  const load = useCallback(async () => {
    setTags(await api<TagRow[]>("/admin/link-tags"));
  }, []);
  useEffect(() => { void load().catch((e) => setError(String(e))); }, [load]);

  const locked = (id: string) => syncing || busyIds.has(id);
  function setBusy(id: string, on: boolean) {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  }
  const draftOf = (id: string, field: string, fallback: string) => drafts[`${id}:${field}`] ?? fallback;
  const setDraft = (id: string, field: string, v: string) =>
    setDrafts((prev) => ({ ...prev, [`${id}:${field}`]: v }));
  const clearDraft = (id: string) =>
    setDrafts((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => !k.startsWith(`${id}:`))));

  // 不变量:初始加载后,整页 GET 只在写锁内发生——锁内发不出新写,陈旧快照无从覆盖别行新值。
  // 引用计数持锁:并发触发多次回拉时,最后一个结束(finally)才解锁——先完成者不得提前放行
  // 新写,否则仍在途的旧 GET 可能覆盖锁外新写;回拉失败设置 error 后解锁,页面停留在旧快照。
  async function reloadLocked() {
    setSyncCount((n) => n + 1);
    try {
      await load();
    } catch (e) {
      setError(String(e)); // 回拉失败必须可见:DB 可能已变,旧快照不再可信
    } finally {
      setSyncCount((n) => n - 1);
    }
  }

  async function create() {
    setCreating(true); // creating 锁:慢网双击不会重复创建
    try {
      const created = await api<TagDto>("/admin/link-tags", {
        method: "POST", body: JSON.stringify({ name: name.trim() }),
      });
      setTags((prev) => prev && [...prev, { ...created, linkCount: 0 }].sort(byOrder));
      setName(""); setError("");
    } catch (e) { setError(String(e)); await reloadLocked(); }
    setCreating(false);
  }

  async function patch(id: string, data: { name?: string; sortOrder?: number }) {
    setBusy(id, true);
    try {
      const updated = await api<TagDto>(`/admin/link-tags/${id}`, {
        method: "PATCH", body: JSON.stringify(data),
      });
      clearDraft(id);
      setError(""); // 先清错再回拉:回拉失败设置的 error 不能被这里覆盖掉
      if (data.sortOrder !== undefined) {
        await reloadLocked(); // 排序:平序组内真序在服务端(createdAt),锁页回拉
      } else {
        setTags((prev) => prev && prev.map((t) => (t.id === id ? { ...t, ...updated } : t)));
      }
    } catch (e) {
      setError(String(e));
      clearDraft(id); // 丢弃草稿,受控输入随 state 复位为服务端值
      await reloadLocked();
    }
    setBusy(id, false);
  }

  async function remove(id: string) {
    setBusy(id, true);
    try {
      await api(`/admin/link-tags/${id}`, { method: "DELETE" });
      setTags((prev) => prev && prev.filter((t) => t.id !== id));
      setError("");
    } catch (e) { setError(String(e)); await reloadLocked(); }
    setBusy(id, false);
  }

  if (!tags) return <p>{error || "加载中…"}</p>;
  return (
    <>
      <h2>外链标签（{tags.length}）</h2>
      <p>标签用于给外链分类（如「实用攻略」「旅行记录」）；改名即时全局生效，被引用的标签不可删除。</p>
      {error && <p style={{ color: "red" }}>{error}</p>}
      <table>
        <thead><tr><th>排序</th><th>名称</th><th>引用数</th><th>操作</th></tr></thead>
        <tbody>
          {tags.map((t) => (
            <tr key={t.id}>
              <td>
                <input
                  type="number" style={{ width: 64 }}
                  value={draftOf(t.id, "sort", String(t.sortOrder))}
                  disabled={locked(t.id)}
                  onChange={(e) => setDraft(t.id, "sort", e.target.value)}
                  onBlur={() => {
                    const next = Number(draftOf(t.id, "sort", String(t.sortOrder)));
                    if (Number.isInteger(next) && next >= 0 && next !== t.sortOrder) {
                      void patch(t.id, { sortOrder: next });
                    } else clearDraft(t.id);
                  }}
                />
              </td>
              <td>
                <input
                  maxLength={12}
                  value={draftOf(t.id, "name", t.name)}
                  disabled={locked(t.id)}
                  onChange={(e) => setDraft(t.id, "name", e.target.value)}
                  onBlur={() => {
                    const next = draftOf(t.id, "name", t.name).trim();
                    if (next && next !== t.name) void patch(t.id, { name: next });
                    else clearDraft(t.id);
                  }}
                />
              </td>
              <td>{t.linkCount}</td>
              <td>
                <button
                  onClick={() => remove(t.id)} disabled={locked(t.id) || t.linkCount > 0}
                  title={t.linkCount > 0 ? "仍有外链使用该标签，先改标或清空" : undefined}
                >删除</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>新增标签</h3>
      <p>
        <input placeholder="如：实用攻略" value={name} maxLength={12} onChange={(e) => setName(e.target.value)} />{" "}
        <button onClick={create} disabled={creating || syncing || !name.trim()}>添加</button>
      </p>
    </>
  );
}
```

- [x] **Step 3: 外链总览页**

新建 `apps/admin/app/links/page.tsx`：

```tsx
"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";

type LinkTag = { id: string; name: string };
type AdminLink = {
  id: string; platform: string; title: string; url: string; sortOrder: number;
  tag: LinkTag | null; place: { id: string; path: string };
};
// PATCH /admin/links/:id 的响应形状(LINK_SELECT,无 place)
type PatchedLink = { id: string; tag: LinkTag | null };
type TagOption = { id: string; name: string; sortOrder: number; linkCount: number };

const PLATFORM_LABELS: Record<string, string> = {
  XIAOHONGSHU: "小红书", BILIBILI: "B 站", DOUYIN: "抖音", WEIBO: "微博", OTHER: "其他",
};

export default function LinksPage() {
  const [items, setItems] = useState<AdminLink[] | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [syncCount, setSyncCount] = useState(0); // 页面级写锁引用计数:>0 期间禁用全页写控件
  const [tags, setTags] = useState<TagOption[]>([]);
  const [onlyUntagged, setOnlyUntagged] = useState(false);
  const [error, setError] = useState("");
  const syncing = syncCount > 0;

  // 双 GET 原子提交:先拿齐两份结果再一起 setState,不提交半份快照(不允许"链接更新了、
  // 标签列表还是旧的/空的");失败向上抛,由初始 effect / reloadLocked 决定如何呈现
  const load = useCallback(async () => {
    const [linkList, tagList] = await Promise.all([
      api<{ items: AdminLink[] }>("/admin/links"),
      api<TagOption[]>("/admin/link-tags"),
    ]);
    setItems(linkList.items);
    setTags(tagList);
  }, []);
  useEffect(() => { void load().catch((e) => setError(String(e))); }, [load]);

  // 不变量:初始加载后,整页 GET 只在写锁内发生——锁内发不出新写,陈旧快照无从覆盖别行新值。
  // 引用计数持锁:并发触发多次回拉时,最后一个结束(finally)才解锁——先完成者不得提前放行
  // 新写,否则仍在途的旧 GET 可能覆盖锁外新写;回拉失败设置 error 后解锁,页面停留在旧快照。
  async function reloadLocked() {
    setSyncCount((n) => n + 1);
    try {
      await load();
    } catch (e) {
      setError(String(e)); // 回拉失败必须可见:DB 可能已变,旧快照不再可信
    } finally {
      setSyncCount((n) => n - 1);
    }
  }

  async function saveTag(linkId: string, tagId: string) {
    setBusyIds((prev) => new Set(prev).add(linkId)); // 在途时禁用该行,同链接操作物理串行
    try {
      const updated = await api<PatchedLink>(`/admin/links/${linkId}`, {
        method: "PATCH", body: JSON.stringify({ tagId: tagId || null }),
      });
      // PATCH 响应即权威值:函数式局部合并,本页初始加载后没有锁外整页 GET
      setItems((prev) => prev && prev.map((l) => (l.id === linkId ? { ...l, tag: updated.tag } : l)));
      setError("");
    } catch (e) {
      setError(String(e));
      await reloadLocked(); // 失败:写锁下回拉服务端真相;select 受控,重渲染即复位
    } finally {
      setBusyIds((prev) => { const next = new Set(prev); next.delete(linkId); return next; });
    }
  }

  if (!items) return <p>{error || "加载中…"}</p>;
  const untagged = items.filter((l) => !l.tag).length;
  const shown = onlyUntagged ? items.filter((l) => !l.tag) : items;
  return (
    <>
      <h2>外链总览（{items.length}，未打标 {untagged}）</h2>
      <p>
        <label>
          <input
            type="checkbox" checked={onlyUntagged}
            onChange={(e) => setOnlyUntagged(e.target.checked)}
          /> 只看未打标
        </label>
        {" ｜ "}
        <Link href="/link-tags">管理标签 →</Link>
      </p>
      {error && <p style={{ color: "red" }}>{error}</p>}
      <table>
        <thead><tr><th>地点</th><th>平台</th><th>标题</th><th>链接</th><th>标签</th></tr></thead>
        <tbody>
          {shown.map((l) => (
            <tr key={l.id}>
              <td><Link href={`/places/${l.place.id}`}>{l.place.path}</Link></td>
              <td>{PLATFORM_LABELS[l.platform] ?? l.platform}</td>
              <td>{l.title}</td>
              <td><a href={l.url} target="_blank" rel="noreferrer">{l.url}</a></td>
              <td>
                <select
                  value={l.tag?.id ?? ""} disabled={syncing || busyIds.has(l.id)}
                  onChange={(e) => saveTag(l.id, e.target.value)}
                >
                  <option value="">（无标签）</option>
                  {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
```

- [x] **Step 4: 地点外链页改造**

`apps/admin/app/places/[id]/page.tsx` 整文件替换（读取切到管理端接口；表格加标签列；新增表单加标签下拉；标题更名并带未打标计数）：

```tsx
"use client";
import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";

type LinkTag = { id: string; name: string };
type PlaceLink = {
  id: string; platform: string; title: string; url: string; sortOrder: number;
  tag: LinkTag | null;
};
type PlaceLinks = {
  id: string; name: string; level: string;
  ancestors: { name: string }[]; links: PlaceLink[];
};
type TagOption = { id: string; name: string; sortOrder: number; linkCount: number };

const PLATFORMS = ["XIAOHONGSHU", "BILIBILI", "DOUYIN", "WEIBO", "OTHER"] as const;
const PLATFORM_LABELS: Record<string, string> = {
  XIAOHONGSHU: "小红书", BILIBILI: "B 站", DOUYIN: "抖音", WEIBO: "微博", OTHER: "其他",
};

// Array.prototype.sort 是稳定排序:平序保持既有相对顺序(≈ 服务端的 createdAt,id 次序)
const byOrder = (a: PlaceLink, b: PlaceLink) => a.sortOrder - b.sortOrder;

export default function PlaceLinksPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [place, setPlace] = useState<PlaceLinks | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [syncCount, setSyncCount] = useState(0); // 页面级写锁引用计数:>0 期间禁用全页写控件
  const [orderDrafts, setOrderDrafts] = useState<Record<string, string>>({}); // 排序输入受控草稿
  const [tags, setTags] = useState<TagOption[]>([]);
  const [error, setError] = useState("");
  const [platform, setPlatform] = useState<string>("XIAOHONGSHU");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [sortOrder, setSortOrder] = useState(0);
  const [tagId, setTagId] = useState("");
  const syncing = syncCount > 0;

  // 管理端读鉴权接口:编辑需要 tagId,公开 DTO 只有标签名。双 GET 原子提交:先拿齐两份
  // 结果再一起 setState,不提交半份快照;失败向上抛,由初始 effect / reloadLocked 决定呈现
  const load = useCallback(async () => {
    const [placeDetail, tagList] = await Promise.all([
      api<PlaceLinks>(`/admin/places/${id}/links`),
      api<TagOption[]>("/admin/link-tags"),
    ]);
    setPlace(placeDetail);
    setTags(tagList);
  }, [id]);
  useEffect(() => { void load().catch((e) => setError(String(e))); }, [load]);

  const locked = (linkId: string) => syncing || busyIds.has(linkId);
  function setBusy(linkId: string, on: boolean) {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(linkId); else next.delete(linkId);
      return next;
    });
  }
  const clearOrderDraft = (linkId: string) =>
    setOrderDrafts((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== linkId)));

  // 不变量:初始加载后,整页 GET 只在写锁内发生——锁内发不出新写,陈旧快照无从覆盖别行新值。
  // 引用计数持锁:并发触发多次回拉时,最后一个结束(finally)才解锁——先完成者不得提前放行
  // 新写,否则仍在途的旧 GET 可能覆盖锁外新写;回拉失败设置 error 后解锁,页面停留在旧快照。
  async function reloadLocked() {
    setSyncCount((n) => n + 1);
    try {
      await load();
    } catch (e) {
      setError(String(e)); // 回拉失败必须可见:DB 可能已变,旧快照不再可信
    } finally {
      setSyncCount((n) => n - 1);
    }
  }

  async function addLink() {
    setCreating(true); // creating 锁:url 无唯一约束,慢网双击的重复创建只能在入口挡
    try {
      const created = await api<PlaceLink>(`/admin/places/${id}/links`, {
        method: "POST",
        body: JSON.stringify({ platform, title, url, sortOrder, tagId: tagId || null }),
      });
      setPlace((prev) => prev && { ...prev, links: [...prev.links, created].sort(byOrder) });
      setTitle(""); setUrl(""); setSortOrder(0); setTagId(""); setError("");
    } catch (e) { setError(String(e)); await reloadLocked(); }
    setCreating(false);
  }

  // 打标:PATCH 响应即权威值,函数式局部合并;本页初始加载后没有锁外整页 GET
  async function saveTag(linkId: string, nextTagId: string) {
    setBusy(linkId, true);
    try {
      const updated = await api<PlaceLink>(`/admin/links/${linkId}`, {
        method: "PATCH", body: JSON.stringify({ tagId: nextTagId || null }),
      });
      setPlace((prev) => prev && {
        ...prev, links: prev.links.map((l) => (l.id === linkId ? updated : l)),
      });
      setError("");
    } catch (e) {
      setError(String(e));
      await reloadLocked(); // 失败:写锁下回拉;select 受控,重渲染即复位
    }
    setBusy(linkId, false);
  }

  // 排序:平序组内真序在服务端(createdAt),成功与失败都在写锁下回拉
  async function saveOrder(linkId: string, next: number) {
    setBusy(linkId, true);
    try {
      await api(`/admin/links/${linkId}`, { method: "PATCH", body: JSON.stringify({ sortOrder: next }) });
      setError("");
    } catch (e) { setError(String(e)); }
    clearOrderDraft(linkId); // 丢弃草稿,受控输入随回拉后的 state 复位
    await reloadLocked();
    setBusy(linkId, false);
  }

  async function removeLink(linkId: string) {
    setBusy(linkId, true);
    try {
      await api(`/admin/links/${linkId}`, { method: "DELETE" });
      setPlace((prev) => prev && { ...prev, links: prev.links.filter((l) => l.id !== linkId) });
      setError("");
    } catch (e) { setError(String(e)); await reloadLocked(); }
    setBusy(linkId, false);
  }

  if (!place) return <p>{error || "加载中…"}</p>;
  const untagged = place.links.filter((l) => !l.tag).length;
  return (
    <>
      <h2>
        {place.ancestors.map((a) => a.name).concat(place.name).join(" · ")}
        ｜网友分享外链（{place.links.length}，未打标 {untagged}）
      </h2>
      <p><Link href="/link-tags">管理标签 →</Link></p>
      {error && <p style={{ color: "red" }}>{error}</p>}
      <table>
        <thead><tr><th>排序</th><th>平台</th><th>标题</th><th>链接</th><th>标签</th><th>操作</th></tr></thead>
        <tbody>
          {place.links.map((l) => (
            <tr key={l.id}>
              <td>
                <input
                  type="number" style={{ width: 64 }}
                  value={orderDrafts[l.id] ?? String(l.sortOrder)}
                  disabled={locked(l.id)}
                  onChange={(e) => setOrderDrafts((prev) => ({ ...prev, [l.id]: e.target.value }))}
                  onBlur={() => {
                    const next = Number(orderDrafts[l.id] ?? String(l.sortOrder));
                    if (Number.isInteger(next) && next >= 0 && next !== l.sortOrder) {
                      void saveOrder(l.id, next);
                    } else clearOrderDraft(l.id);
                  }}
                />
              </td>
              <td>{PLATFORM_LABELS[l.platform] ?? l.platform}</td>
              <td>{l.title}</td>
              <td><a href={l.url} target="_blank" rel="noreferrer">{l.url}</a></td>
              <td>
                <select
                  value={l.tag?.id ?? ""} disabled={locked(l.id)}
                  onChange={(e) => saveTag(l.id, e.target.value)}
                >
                  <option value="">（无标签）</option>
                  {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </td>
              <td><button onClick={() => removeLink(l.id)} disabled={locked(l.id)}>删除</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>新增外链</h3>
      <p>
        <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
          {PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABELS[p]}</option>)}
        </select>{" "}
        <input placeholder="标题" value={title} onChange={(e) => setTitle(e.target.value)} />{" "}
        <input placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} size={40} />{" "}
        <input type="number" value={sortOrder} onChange={(e) => setSortOrder(Number(e.target.value))} style={{ width: 64 }} />{" "}
        <select value={tagId} onChange={(e) => setTagId(e.target.value)}>
          <option value="">（无标签）</option>
          {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>{" "}
        <button onClick={addLink} disabled={creating || syncing || !title || !url.trim().startsWith("https://")}>添加</button>
      </p>
    </>
  );
}
```

- [x] **Step 5: build 验证**

```sh
pnpm -C apps/admin build
```

Expected: 编译通过、无类型错误。

- [x] **Step 6: 人工走查**

dev server 常驻前台不退出，三条命令不能放在同一个 shell 里顺序执行——各开一个终端：

终端 1（基础设施，命令执行完即退出）：

```sh
pnpm db:up
```

终端 2（API，保持前台常驻）：

```sh
pnpm --filter @zhixing/api dev
```

终端 3（管理端，保持前台常驻）：

```sh
pnpm --filter @zhixing/admin dev
```

走查清单（开发库操作，无副作用顾虑）：
1. `/link-tags`：新增「实用攻略」「旅行记录」→ 改名 → 调排序 → 删除未引用标签成功；
2. 任一地点页：新增外链带标签、表格下拉改标/取消标、未打标计数随之变化；
3. `/link-tags`：删除被引用标签 → 按钮禁用（用 curl 直发 DELETE 验证 409 亦可）；
4. `/links`：全量列表地点路径正确、「只看未打标」筛选生效、下拉打标后计数下降；
5. 竞态防线抽查（DevTools Network 调慢速档）：改某行标签后立即再操作同一行——控件禁用（请求在途）；打标成功后 UI 值来自 PATCH 响应而非整页刷新；慢网下快速双击「添加」（标签页与外链页各试一次）只产生一条记录；临时停掉 API 后改名/打标——输入框复位为服务端值、回拉期间页面全禁写；此时回拉同样失败，错误提示保持可见（不被后续清空）、页面解锁但停在旧快照，重启 API 后刷新即齐；
6. `GET /places/:id`（curl）：已打标链接 `tag` 为标签名，未打标为 `null`，响应无 `tagId`。

- [x] **Step 7: 提交**

```sh
git add apps/admin/app/link-tags apps/admin/app/links "apps/admin/app/places/[id]/page.tsx" apps/admin/app/layout.tsx
git commit -m "feat(admin): 标签管理、外链总览与地点外链打标

新增 /link-tags(增删改+引用计数防误删)与 /links(全量总览+只看未打标,
存量打标入口);地点外链页切到 /admin/places/:id/links,加标签列与
新增表单标签下拉,标题更名网友分享外链并显示未打标计数;导航加外链入口。
spec: docs/superpowers/specs/2026-08-12-place-link-tags-design.md"
```

---

### Task 5: iOS 更名「网友分享」与标签 chip

**Files:**
- Modify: `apps/ios/Tests/InteractionDesignTests.swift`（`testPlaceLinksIsAStandaloneDrawerSection`）
- Modify: `apps/ios/Tests/PlacePathTests.swift`（追加两个解码用例）
- Modify: `apps/ios/Zhixing/Core/Models.swift`（`PlaceLink` 加 `tag`）
- Modify: `apps/ios/Zhixing/Place/PlaceLinksSection.swift`（chip、文案、URL trim）
- Modify: `apps/ios/Zhixing/Place/PlaceDrawer.swift`（枚举 rawValue 与注释）

- [x] **Step 1: 先改守卫测试（失败）**

① `InteractionDesignTests.testPlaceLinksIsAStandaloneDrawerSection` 内更新/追加：

```swift
        // 四段分栏,网友分享紧随风物卡之后
        let cards = try XCTUnwrap(drawer.range(of: "case cards = \"风物卡\""))
        let guides = try XCTUnwrap(drawer.range(of: "case links = \"网友分享\""))
```

（`stories` 断言与两条顺序断言不动）；文件尾部两条断言更新并追加：

```swift
        XCTAssertTrue(links.contains("ZXSectionEmptyState"))
        XCTAssertTrue(links.contains("分享还在收集中"))
        // 标签 chip 只在 tag 非 nil 时渲染;打开前 trim 容错存量空白 URL
        XCTAssertTrue(links.contains("if let tag = link.tag"))
        XCTAssertTrue(links.contains("trimmingCharacters(in: .whitespacesAndNewlines)"))
```

② `PlacePathTests` 类内追加：

```swift
    func testPlaceLinkDecodesTag() throws {
        let json = """
        {"id":"p1","name":"香港","level":"CITY","intro":null,"ancestors":[],
         "links":[{"id":"l1","platform":"BILIBILI","title":"200 元穷游香港",
                   "url":"https://example.com/hk","sortOrder":0,"tag":"实用攻略"}]}
        """
        let detail = try APIClient.decoder.decode(PlaceDetail.self, from: Data(json.utf8))
        XCTAssertEqual(detail.links?.first?.tag, "实用攻略")
    }

    /// 老服务端/旧缓存无 tag 字段:解码不崩,chip 数据为 nil(未打标同形)。
    func testPlaceLinkToleratesMissingTag() throws {
        let json = """
        {"id":"p1","name":"香港","level":"CITY","intro":null,"ancestors":[],
         "links":[{"id":"l1","platform":"DOUYIN","title":"香港旅行记录",
                   "url":"https://example.com/a","sortOrder":0}]}
        """
        let detail = try APIClient.decoder.decode(PlaceDetail.self, from: Data(json.utf8))
        XCTAssertNil(detail.links?.first?.tag)
    }
```

- [x] **Step 2: 跑单测确认失败**

从仓库根执行（子 shell 包裹，不改变当前 cwd，可反复整块重跑）：

```sh
(
  cd apps/ios && xcodegen generate
  SIM=$(xcrun simctl list devices available | grep -oE "iPhone [^(]+" | head -1 | xargs)
  xcodebuild -project Zhixing.xcodeproj -scheme Zhixing \
    -destination "platform=iOS Simulator,name=$SIM" \
    -only-testing:ZhixingTests/InteractionDesignTests -only-testing:ZhixingTests/PlacePathTests test
)
```

Expected: **FAIL**（`PlaceLink` 无 `tag` 属性时 `PlacePathTests` 编译失败；先加不带 UI 的模型字段可让编译过、断言红——两种失败形态均可接受）。

- [x] **Step 3: Models.swift**

`PlaceLink` 加字段（`url` 之后）：

```swift
    /// 管理端维护的内容标签名(如"实用攻略""旅行记录");老服务端/未打标为 nil,不渲染 chip。
    let tag: String?
```

第 19 行注释「网友攻略分栏」改「网友分享分栏」，第 26 行注释同步。

- [x] **Step 4: PlaceLinksSection.swift**

① 头注释「网友攻略」→「网友分享」。
② 空态：

```swift
                        ZXSectionEmptyState(
                            icon: "link",
                            eyebrow: "网友分享",
                            title: "分享还在收集中",
                            message: "我们会陆续为这里挑选值得一看的旅行记录与实用攻略。")
```

③ 链接行 HStack，平台徽章之后、标题之前插入 chip（刻意比 cinnabar 平台徽章安静——次级信息不做第二处红色强调）：

```swift
                                if let tag = link.tag {
                                    Text(tag)
                                        .font(.caption2.weight(.semibold))
                                        .padding(.horizontal, 8).padding(.vertical, 3)
                                        .foregroundStyle(.secondary)
                                        .background(Color(.tertiarySystemFill), in: Capsule())
                                }
```

④ 失败文案：`state = .failed("网友分享加载失败，请重试")`。
⑤ `open(_:)` 首行改为：

```swift
        let trimmed = link.url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed), url.scheme == "https" else { return }
```

- [x] **Step 5: PlaceDrawer.swift**

`case links = "网友攻略"` → `case links = "网友分享"`；枚举注释里的「网友攻略」同步改「网友分享」。

- [x] **Step 6: 跑单测确认通过，全量回归**

重跑 Step 2 的完整命令块（子 shell 自包含）→ PASS；然后从**仓库根**执行全量回归：

```sh
scripts/ios-test.sh
```

Expected: `** TEST SUCCEEDED **`。

- [x] **Step 7: 提交**

```sh
git add apps/ios/Zhixing/Core/Models.swift apps/ios/Zhixing/Place/PlaceLinksSection.swift apps/ios/Zhixing/Place/PlaceDrawer.swift apps/ios/Tests/InteractionDesignTests.swift apps/ios/Tests/PlacePathTests.swift
git commit -m "feat(ios): 网友攻略更名网友分享并展示外链内容标签

分栏更名网友分享(罩住攻略/记录/讲解三类站外内容);PlaceLink 加可选 tag,
链接行渲染安静标签 chip(tertiarySystemFill 胶囊,弱于平台徽章);
open 前 trim URL 容错存量首尾空白;空态/失败文案同步更名。
spec: docs/superpowers/specs/2026-08-12-place-link-tags-design.md"
```

---

### Task 6: 运营与部署文档、全链路回归

**Files:**
- Modify: `docs/content-ops.md`（新增「外链标签运营」小节）
- Modify: `docs/deploy.md`（存量升级命令改两段式，保证 admin 晚于新 API）

- [x] **Step 1: content-ops.md 补运营流程**

在外链/内容维护相关小节附近（无则文末）新增：

```markdown
## 外链标签运营

外链内容标签在管理后台「外链 → 管理标签」维护（增删改即时生效，无需发版）。
建议初始标签：**实用攻略**、**旅行记录**；存量中已出现的历史/人文讲解类内容可另建**深度讲解**；
遇到三类都不属于的内容时再建**其他**做兜底。

**打标流程**：管理后台「外链」总览页勾选「只看未打标」，逐条打开原内容判断后在下拉中选标签；
页面标题的未打标计数归零即完成。日常新增外链时在地点页的新增表单直接选标签。

**判据**（按主要消费价值判断；仅凭标题拿不准的必须打开原内容）：
- 实用攻略：路线、交通、预约、费用、时间安排、避坑、机位等可执行信息——帮助行动；
- 旅行记录：第一人称旅行过程/挑战，或无解说的沉浸影像、Citywalk、风景漫步——感受与代入;
- 深度讲解：第三人称讲清一个地方的历史/人文/地理——理解。

看过且确实不属于三类的，归入**其他**标签（App 会显示「其他」chip，可接受），不要留在未打标里——
未打标必须只表示「还没处理」，计数归零才是存量处理完成的判据；暂时拿不准的保持未打标，下次继续看。
失效/无法访问的链接不打标，在地点页直接删除。
删除标签前先把引用改完（引用数 > 0 时删除按钮禁用）；改名即时全局生效，无需重新打标。
```

- [x] **Step 2: docs/deploy.md 升级命令改两段式（现行「步骤」3、4 一并改写）**

现有 runbook 的一次性 `up -d --build` 不保证 admin 晚于新 API（compose 里 admin 不依赖 api，migration 又在 api 容器启动命令里执行）。修订范围是现行「步骤」一节的**第 3、4 两步**，不只是启动命令：

① 第 3 步（一次性 `up -d --build`）替换为下面的两段式脚本。**门槛必须 fail-closed**——断言失败脚本即中止，绝不带病继续起 admin（占位域名用真实变量，`<域名>` 直接写在 URL 里会被 zsh 当输入重定向）；每个 curl 都带 `--connect-timeout`/`--max-time`，单次探测有界，等待循环才有总上限（60 次 × (探测 ≤5s + 间隔 2s)，约 7 分钟封顶，正常几秒内通过）：

```sh
set -euo pipefail
ZX_API_BASE="https://api.example.com"   # 以实际生产 API 域名为准

docker compose -f compose.prod.yml --env-file .env.production up -d --build db minio api

# 等新 API 就绪:/health 通,且未带鉴权的新 /admin 路由返回 401
# (旧 API 是 404;401 = 新路由已注册,只是没带 token)
for i in $(seq 1 60); do
  curl -fsS --connect-timeout 2 --max-time 5 "$ZX_API_BASE/health" >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS --connect-timeout 2 --max-time 5 "$ZX_API_BASE/health" >/dev/null
test "$(curl -s --connect-timeout 2 --max-time 5 -o /dev/null -w '%{http_code}' "$ZX_API_BASE/admin/link-tags")" = "401" \
  || { echo "新 API 未就绪(期望 401),中止,不部署 admin" >&2; exit 1; }

docker compose -f compose.prod.yml --env-file .env.production up -d --build admin
```

② 第 4 步的 `curl https://api.<域名>/health` 手工验证是不可执行的占位命令，且其职责已被上面脚本的硬断言覆盖——该步改写为只保留「浏览器打开 `https://admin.<域名>` 验证管理端可访问」。

- [x] **Step 3: 全链路回归**

```sh
pnpm test                              # root,含 packages/db(共享测试库,串行)
pnpm -C apps/api exec vitest run       # api 全量
pnpm -C apps/admin build               # 管理端编译
scripts/ios-test.sh                    # iOS 全量
```

Expected: 全部通过。

- [x] **Step 4: 提交**

```sh
git add docs/content-ops.md docs/deploy.md
git commit -m "docs(ops): 外链标签运营流程与两段式升级顺序

content-ops 补打标判据(不属于三类归「其他」,未打标只表示待处理);
deploy 升级命令拆两段,保证 admin 晚于新 API 就绪。
spec: docs/superpowers/specs/2026-08-12-place-link-tags-design.md"
```

---

## 收尾（人工）

- **模拟器/Catalyst 走查**（源码断言锁不住视觉）：开发库里给某地点的外链打上标签后，看链接行 chip 观感（与 cinnabar 平台徽章的主次关系、长标题挤压）；无标签行与今日一致；空态新文案；断网失败可重试。
- **上线顺序**（两段式 + fail-closed 门槛，Task 6 已写进 docs/deploy.md）：备份后先 `up -d --build db minio api`（migration 随 api 容器启动执行），用 `test "$(curl ...)" = "401"` 硬断言未带鉴权的 `GET /admin/link-tags` 返回 401（旧 API 是 404），断言失败即中止；通过后才 `up -d --build admin`。一次性全量 `up -d --build` 不保证 admin 晚于 API，禁止使用。
- **存量打标**（上线后运营动作）：后台建「实用攻略」「旅行记录」（视内容加「深度讲解」，需要兜底时加「其他」）→「外链」页只看未打标 → 逐条打开原内容打标（不属于三类的归「其他」，拿不准的留在未打标待办）→ 未打标计数归零即完成。判据见 docs/content-ops.md。
- iOS 随下一次 TestFlight 发版；老版本 App 忽略 tag 字段，不受服务端先行影响。
