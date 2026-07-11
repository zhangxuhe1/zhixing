# 知行 邮箱验证码登录 + 身份表独立化（服务端）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用户身份与登录凭据解耦（Identity 身份表取代 `User.appleSub` 列），并新增邮箱验证码（OTP）登录——为 Mac Catalyst dmg 在无 Apple 会员条件下提供可用登录，同时为将来安卓（Google）/ Web（微信）登录一次性铺平表结构。

**Architecture:** 三步扩张-切换-收缩完成身份表迁移（加表回填 → 消费方切换 → 删旧列），每步全量测试保持绿。邮箱登录为无密码 OTP：`/auth/email/send` 发 6 位码，`/auth/email/verify` 校验后走与 Apple 登录同一条 `loginByIdentity` → `signSession` 通道。发信经 nodemailer + SMTP_URL，未配置时退化为控制台打印（对齐"零配置可跑"惯例）；测试从真实测试库直接读码，不 mock。

**Tech Stack:** Fastify 5 + Prisma 6 + PostgreSQL(5433) + zod + vitest；新增依赖仅 `nodemailer` 与 `@types/nodemailer`（apps/api）。

**规格：** docs/superpowers/specs/2026-07-08-multiplatform-pre-research.md（第二部分 macOS 路线、"立项前待决策清单"第 3 条身份表独立化）。客户端（SignInScreen 邮箱登录 UI + Catalyst 目标 + dmg 打包）按 m1-server → m1-ios 惯例另立后续计划，不在本篇。

## 背景与决策记录（执行者无对话上下文，此节自包含）

- **动机**：无 Apple 会员时 SIWA entitlement 签不进 Mac Catalyst 构建，dev auth 又绝不可开在生产——朋友拿到 dmg 后将无法登录生产服务器。邮箱 OTP 登录不依赖任何 Apple 能力，彻底解开该死结。
- **为何做身份表而非给 User 加 email 列**：预研文档决策清单第 3 条已定"随首个新 provider 一并做身份表独立化"。生产库尚未部署（空库窗口期，迁移零风险）；且"同一人 iPhone Apple 登录 + Mac 邮箱登录"的账号绑定需求已可预见，列式结构做绑定要搬列值合并行，身份表只需改一行 `userId` 指向。
- **参考实现**：参考项目 项目（Next.js）的邮箱 OTP 已在生产验证，其流程与邮件模板版式（表格布局 + 内联样式，兼容 QQ/163 邮箱客户端）值得移植；但其三处短板本计划必须补齐——①verify 无尝试次数上限（可爆破）②`Math.random()` 生成验证码（非 CSPRNG）③无每邮箱日发送上限（可被用于邮件轰炸）。所需契约已全部内联到任务中，**执行时不需要读取 参考项目 仓库**。
- **验证码安全参数**（集中为常量，禁止散落魔数）：6 位数字、10 分钟有效、同邮箱 60 秒冷却、同邮箱 24 小时 ≤ 10 次、单码错误尝试 ≤ 5 次即作废、`crypto.randomInt` 生成。
- **`/auth/dev` 契约冻结**：请求体仍为 `{ appleSub, nickname? }`（语义变为"以该 subject 造一条 APPLE 身份"）。全部 API 测试经 `userAuth()` 走此端点造用户，参数名不动则测试面零波及。

## Global Constraints

- **本计划只定义接口与行为，不含可粘贴的实现代码**（M1 台账教训）。代码块仅限：Prisma schema 片段（声明式）、迁移 SQL 契约、TS 类型/签名、端点契约、测试用例表。实现由实现者按契约编写，审查者按契约验收。
- 测试用真实 PG/MinIO，不 mock。前置：`open -a Docker`（如未跑）→ `pnpm db:up` → `pnpm -C packages/db push:test`。测试库 `postgresql://zhixing:zhixing@localhost:5433/zhixing_test`。
- **schema 每变更一次，须重跑 `pnpm -C packages/db push:test` 同步测试库，并把新表加进两处 TRUNCATE 清单**：`apps/api/test/helpers.ts` 与 `packages/db/test/*.ts`（共 5 个文件）。
- pnpm 钉 `10.34.4`（勿动 packageManager 字段）；Node >= 22；ESM + `.js` 后缀相对导入。
- commit 信息中文，尾行 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- 错误响应统一 `{ error: string, detail?: any }`；body 校验一律 zod，失败 400 `invalid_body`。
- **邮箱规范化唯一入口**：`normalizeEmail`（trim + 小写），send/verify/身份 subject 三处必须共用，禁止各自手写。
- **公开 DTO 禁字段扩展**：在原有 userId/appleSub/lat/lng/精确 takenAt 之上，增加 `email` 与 `subject`——邮箱是 PII，任何公开端点响应序列化后不得含这两个字段名。
- 发信副作用受 `config.smtp.url` 控制：空 = 控制台打印（dev/test 默认，测试绝不真发信）；测试对码的获取一律直查 `EmailCode` 表。
- 路由文件模式：`export async function xxxRoutes(app: FastifyInstance)`；`/auth/*` 端点必须挂 `authRateLimit`（按 `req.ip` 计数，见 routes/auth.ts 现有注释——防伪造 Bearer 头绕桶）。
- 每任务结束跑 `pnpm -C apps/api exec vitest run` 与 `pnpm -C packages/db exec vitest run` 确认无回归后 commit。

---

### Task S1: 身份表扩张（Identity 建表 + appleSub 改可空 + 回填迁移）

本任务后 `appleSub` 列仍在、登录逻辑不动，一切照旧工作；Identity 成为 appleSub 的超集副本。

**Files:**
- Modify: `packages/db/prisma/schema.prisma`
- Create: `packages/db/test/identity.test.ts`
- Modify（TRUNCATE 清单加 `"Identity"`，紧跟 `"User"` 之后）: `apps/api/test/helpers.ts:43`、`packages/db/test/schema.test.ts:10`、`packages/db/test/seed.test.ts:42`、`packages/db/test/m2-models.test.ts:10`、`packages/db/test/seed-extras.test.ts:52`
- 迁移产物: `packages/db/prisma/migrations/<timestamp>_identity_table/`

**Interfaces:**
- Consumes: 现有 `User` 模型（`appleSub String @unique`）。
- Produces: 枚举 `IdentityProvider`、模型 `Identity`、`User.identities` 关系、`User.appleSub` 变为可空——S2 起全部消费方经 `@zhixing/db` Prisma 类型使用。

**Schema 增量（声明式契约）：**

```prisma
enum IdentityProvider {
  APPLE
  EMAIL
}

model Identity {
  id        String           @id @default(cuid())
  userId    String
  user      User             @relation(fields: [userId], references: [id], onDelete: Cascade)
  provider  IdentityProvider
  subject   String           // APPLE = identityToken 的 sub；EMAIL = normalizeEmail 后的邮箱
  createdAt DateTime         @default(now())

  @@unique([provider, subject])
  @@index([userId])
}
```

`User.appleSub` 由 `String @unique` 改为 `String? @unique`（S3 删除）；`User` 增加 `identities Identity[]`。

**迁移 SQL 契约**（`prisma migrate dev --create-only -n identity_table` 生成后，在建表语句之后、事务内追加回填；回填行 id 用 `gen_random_uuid()::text`——cuid 是应用层默认，库内无此函数，唯一性足矣）：

```sql
INSERT INTO "Identity" ("id", "userId", "provider", "subject", "createdAt")
SELECT gen_random_uuid()::text, "id", 'APPLE', "appleSub", now() FROM "User";
```

**Steps:**

- [ ] **写失败测试** `packages/db/test/identity.test.ts`（沿用该目录现有测试的连库与 TRUNCATE 模式），用例：①建 User + 嵌套建 APPLE Identity，按 `(provider, subject)` 复合唯一键查回；②同 `(provider, subject)` 二次插入触发唯一约束错误；③删 User 级联删 Identity；④同一 User 可挂 APPLE 与 EMAIL 两条身份
- [ ] 跑 `pnpm -C packages/db exec vitest run test/identity.test.ts`，预期 FAIL（`Identity` 模型不存在）
- [ ] 修改 schema.prisma（上述契约：枚举 + Identity 模型 + appleSub 可空 + identities 关系）
- [ ] `pnpm --filter @zhixing/db exec prisma migrate dev --create-only --name identity_table` 生成迁移，按上述 SQL 契约手工插入回填语句，再 `pnpm --filter @zhixing/db exec prisma migrate dev` 应用
- [ ] 验证回填：对 dev 库执行 `SELECT (SELECT count(*) FROM "User") AS users, (SELECT count(*) FROM "Identity") AS identities;`，两数须相等
- [ ] `pnpm -C packages/db push:test` 同步测试库
- [ ] 五个文件的 TRUNCATE 清单加 `"Identity"`
- [ ] 跑 `pnpm -C packages/db exec vitest run test/identity.test.ts`，预期 PASS
- [ ] 全量回归：`pnpm -C apps/api exec vitest run` 与 `pnpm -C packages/db exec vitest run` 全绿（此时无任何消费方变更，理应全绿）
- [ ] Commit: `feat(db): 身份表 Identity 落地（appleSub 改可空 + 回填迁移）`

---

### Task S2: 消费方切换（登录与 seed 全面改走 Identity，appleSub 停止读写）

本任务后代码里不再有任何 `user.appleSub` 读写（schema 列仍在，S3 删）。

**Files:**
- Modify: `apps/api/src/routes/auth.ts`（`loginBySub` → `loginByIdentity`）
- Modify: `packages/db/src/seed/index.ts`（用户批量创建、wipe 圈定、dev 账号 upsert 三处）
- Modify: `packages/db/src/seed/common.ts`（SeedUser 类型注释：appleSub 语义改为"APPLE 身份 subject"，字段名可保留）
- Modify: `packages/db/src/seed/extras.ts`（dev 账号相关注释与查找逻辑）
- Modify: `apps/api/test/auth.test.ts`（追加 Identity 行断言）
- Modify: `packages/db/test/seed.test.ts`、`packages/db/test/seed-extras.test.ts`（appleSub 断言改为 Identity 断言）

**Interfaces:**
- Consumes: S1 的 `Identity` 模型与 `IdentityProvider` 枚举。
- Produces: `loginByIdentity`——S5 的邮箱登录复用它，签名如下：

```ts
async function loginByIdentity(
  app: FastifyInstance,
  provider: IdentityProvider,
  subject: string,
  nickname?: string,
): Promise<{ token: string; user: { id: string; nickname: string } }>
```

**行为契约：**

- 查 `Identity`（`provider_subject` 复合唯一）并带出 user：命中且传了 nickname → 更新昵称；未命中 → 单次 `prisma.user.create` 嵌套 `identities.create` 同时建 User 与 Identity。
- 并发兜底：嵌套创建撞 P2002（两个首登请求竞态）→ 重查一次 Identity 后按命中路径返回，不向上抛。
- 默认昵称：APPLE = `旅人${subject.slice(-4)}`（与现状逐字节一致，保 seed/dev 既有数据兼容）；EMAIL = 邮箱本地部分（@ 前）截前 20 字符（昵称约束 1–20 字）。
- `/auth/apple`、`/auth/dev` 端点的请求/响应契约完全不变；`/auth/dev` 的 `appleSub` 参数即 APPLE 身份的 subject。
- seed 三处改造：①用户 createMany 后按同一 plan 数组 createMany 对应 APPLE Identity（seed 自带显式 user id，可直接引用）；②wipe 圈定从 `user.appleSub startsWith "seed-"` 改为经 Identity（provider=APPLE 且 subject startsWith "seed-"）反查 userId 后删 User（Identity 级联随删）；③dev 账号（subject=`simulator-dev`）从按 appleSub upsert 改为按 `provider_subject` 查 Identity、未命中则显式 id 建 User+Identity——与 `/auth/dev` 首登产物完全同构，先 seed 后登录仍复用同一行。

**Steps:**

- [ ] **写失败测试**：auth.test.ts 追加用例"apple 登录产生一条 (APPLE, sub) Identity；同 sub 二登不增行"；seed.test.ts / seed-extras.test.ts 将 appleSub 断言改写为 Identity 断言（此刻 seed 实现未改，预期 FAIL）
- [ ] 跑 `pnpm -C apps/api exec vitest run test/auth.test.ts`，预期新增用例 FAIL
- [ ] 实现 `loginByIdentity` 并替换 routes/auth.ts 内两处调用（`/auth/apple` 传 `("APPLE", sub, nickname)`；`/auth/dev` 传 `("APPLE", body.appleSub, nickname)`）
- [ ] 跑 `pnpm -C apps/api exec vitest run test/auth.test.ts`，预期 PASS
- [ ] 按契约改造 seed 三处及注释
- [ ] 跑 `pnpm -C packages/db exec vitest run`，预期 seed 相关测试 PASS
- [ ] 全量回归：两包 vitest 全绿（重点确认 helpers.ts 的 `userAuth` 未改而全部依赖它的测试通过）
- [ ] Commit: `refactor(api,db): 登录与 seed 切换 Identity，appleSub 停止读写`

---

### Task S3: 收缩（删除 User.appleSub 列）

**Files:**
- Modify: `packages/db/prisma/schema.prisma`（删 `appleSub` 字段）
- 迁移产物: `packages/db/prisma/migrations/<timestamp>_drop_apple_sub/`

**Interfaces:**
- Consumes: S2 完成后代码零处引用 `appleSub`（Prisma 字段）。
- Produces: Identity 成为唯一凭据来源；`grep -rn "appleSub" --include="*.ts" --include="*.prisma"` 仅剩 `/auth/dev` 请求参数名与 seed 的 SeedUser 字段名（均为 API/类型层命名，非 User 列引用）。

**Steps:**

- [ ] schema.prisma 删除 `User.appleSub`，`pnpm --filter @zhixing/db exec prisma migrate dev --name drop_apple_sub`（生成的 DROP COLUMN 无需手工编辑）
- [ ] `pnpm -C packages/db push:test`
- [ ] 全仓 `grep -rn '\.appleSub' apps/api/src packages/db/src` 确认零命中（TS 编译期也会兜底：若有漏网之鱼 vitest 启动即报类型错）
- [ ] 全量回归：两包 vitest 全绿
- [ ] Commit: `feat(db): 删除 User.appleSub 列，Identity 成为唯一凭据源`

---

### Task S4: EmailCode 模型 + 邮件基建（nodemailer / config.smtp / dev 控制台模式）

**Files:**
- Modify: `packages/db/prisma/schema.prisma`（新增 EmailCode）
- Create: `apps/api/src/mailer.ts`
- Modify: `apps/api/src/config.ts`（新增 `smtp` 段）
- Modify: `apps/api/package.json`（`nodemailer` 入 dependencies，`@types/nodemailer` 入 devDependencies）
- Modify（TRUNCATE 清单加 `"EmailCode"`）: S1 列出的同 5 个文件
- 迁移产物: `packages/db/prisma/migrations/<timestamp>_email_code/`

**Interfaces:**
- Consumes: 无（独立基建）。
- Produces: `EmailCode` 模型、`config.smtp: { url: string; from: string }`、以及供 S5 使用的：

```ts
export function renderCodeEmail(code: string): { subject: string; text: string; html: string };
export async function sendMail(to: string, subject: string, text: string, html?: string): Promise<void>;
```

**Schema 增量（声明式契约）：**

```prisma
model EmailCode {
  id        String   @id @default(cuid())
  email     String   // normalizeEmail 后的地址
  code      String   // 6 位数字
  attempts  Int      @default(0)
  expiresAt DateTime
  createdAt DateTime @default(now())

  @@index([email])
}
```

**行为契约：**

- `config.smtp`：`url` 取 `SMTP_URL ?? ""`，`from` 取 `MAIL_FROM ?? "知行 <noreply@example.com>"`（对齐 config.ts 现有"每项都有 dev 默认值"风格）。
- `sendMail`：`config.smtp.url` 为空 → 仅 `console.log` 收件人/主题/正文后返回（dev/test 模式，绝无网络副作用）；非空 → `nodemailer.createTransport(url)` 发送，from 取 `config.smtp.from`。主题统一加 `【知行】` 前缀。
- `renderCodeEmail`：产出纯文本与 HTML 双版本。HTML 必须用表格布局 + 全内联样式（QQ 邮箱/163 客户端不支持现代 CSS）：外层灰底居中，内层 480px 白卡片（品牌头部"知行"、正文含大号等宽居中验证码块、页脚"系统自动发送请勿回复"），文案中文：正文"你正在登录知行，本次登录验证码：」+ 码块 + 「验证码 10 分钟内有效。如非本人操作，请忽略这封邮件。"。所有插值经 HTML 转义。
- EmailCode 无外键（按 email 索引查询），因此**必须**显式进 TRUNCATE 清单（无级联可依赖）。

**Steps:**

- [ ] **写失败测试**：`packages/db/test/identity.test.ts` 内追加（或新建同风格用例）"EmailCode 建行、按 email 查回、attempts 默认 0"，预期 FAIL（模型不存在）
- [ ] schema.prisma 增加 EmailCode，`pnpm --filter @zhixing/db exec prisma migrate dev --name email_code`，`pnpm -C packages/db push:test`
- [ ] 五个文件 TRUNCATE 清单加 `"EmailCode"`
- [ ] 跑 `pnpm -C packages/db exec vitest run`，预期 PASS
- [ ] `pnpm --filter @zhixing/api add nodemailer && pnpm --filter @zhixing/api add -D @types/nodemailer`
- [ ] 按契约实现 config.smtp 段与 mailer.ts（renderCodeEmail 的 HTML 版式可参考本计划"背景与决策记录"所述 参考项目 版式要点，但品牌文案用知行）
- [ ] 快速冒烟：`SMTP_URL` 未设时在 REPL/临时脚本调 `sendMail` 走控制台分支不抛错（无需为打印行为写正式测试；行为验证收敛在 S5 集成测试）
- [ ] 全量回归：两包 vitest 全绿
- [ ] Commit: `feat(api): EmailCode 模型与邮件基建（nodemailer + dev 控制台模式）`

---

### Task S5: 邮箱验证码登录端点（含爆破/冷却/日限三重加固）

**Files:**
- Create: `apps/api/src/emailAuth.ts`
- Modify: `apps/api/src/routes/auth.ts`（注册两个新端点，复用 `loginByIdentity` 与 `authRateLimit`）
- Create: `apps/api/test/email-auth.test.ts`
- Modify: `apps/api/test/rate-limit.test.ts`（新端点按 IP 限流探测）
- Modify: `apps/api/test/public.test.ts:82`（禁字段清单追加 `'"email"'` 与 `'"subject"'`）

**Interfaces:**
- Consumes: S2 的 `loginByIdentity`、S4 的 `EmailCode` / `sendMail` / `renderCodeEmail`。
- Produces: 端点契约（客户端后续计划按此对接）与：

```ts
// apps/api/src/emailAuth.ts
export const EMAIL_CODE = {
  length: 6,
  ttlMs: 10 * 60_000,
  cooldownMs: 60_000,
  dailyMax: 10,       // 滚动 24h 窗口
  maxAttempts: 5,
} as const;
export class EmailCooldownError extends Error {}   // 冷却与日限统一抛它 → 路由层 429
export function normalizeEmail(raw: string): string;                       // trim + toLowerCase
export async function issueEmailCode(prisma: PrismaClient, email: string): Promise<void>;
export async function verifyEmailCode(prisma: PrismaClient, email: string, code: string): Promise<boolean>;
```

**端点契约（均挂 `authRateLimit`，与 `/auth/apple` 同款按 `req.ip` 计数）：**

| 端点 | 请求体 | 成功 | 失败 |
|---|---|---|---|
| `POST /auth/email/send` | `{ email }` | 200 `{ ok: true }` | 400 `invalid_body`；429 `rate_limited`（冷却/日限） |
| `POST /auth/email/verify` | `{ email, code }` | 200 `{ token, user: { id, nickname } }`（与 `/auth/apple` 同构） | 400 `invalid_body`；401 `invalid_code`（错/过期/已废） |

**行为契约：**

- 两端点入口先 `normalizeEmail`，zod 校验规范化后的 email 格式与 code 为 6 位数字串。
- `issueEmailCode`：最近一条该邮箱记录距今 < 60s → 抛 `EmailCooldownError`；24h 内该邮箱记录数 ≥ 10 → 同样抛出；通过后 `crypto.randomInt(0, 1_000_000)` 补零到 6 位，落库（expiresAt = now + 10min），`sendMail(email, ...renderCodeEmail(code))`。
- `verifyEmailCode`：取该邮箱**最新一条未过期**记录（旧码隐式作废）；无记录或 `attempts >= 5` → false；码不等 → `attempts` 自增后 false；码相等 → `deleteMany` 该邮箱全部码后 true。
- 路由层：verify 通过 → `loginByIdentity(app, "EMAIL", email)`；失败一律 401 `invalid_code`（不区分"错/过期/超试"，不给攻击者反馈面）。

**测试用例表（email-auth.test.ts，真实测试库直查 EmailCode 取码，绝不 mock）：**

| # | 场景 | 步骤 | 预期 |
|---|---|---|---|
| 1 | 发码成功与规范化 | send `{ email: " Foo@Test.Dev " }` | 200；表内一行 email=`foo@test.dev`，code 匹配 `^\d{6}$`，expiresAt≈now+10min |
| 2 | 登录闭环 | 直查表取码 → verify → 携 token 访问 `/me` | verify 200 返回 token/user；/me 200；User 一行 + Identity(EMAIL, foo@test.dev) 一行；该邮箱 EmailCode 清空 |
| 3 | 单次使用 | 同码二次 verify | 401 `invalid_code` |
| 4 | 复登录归一账号 | 再走 send+verify，email 换大小写 `FOO@test.dev` | 同一 user.id；`user.count()` == 1 |
| 5 | 默认昵称 | 首登后查 user | nickname == 邮箱本地部分（≤20 字） |
| 6 | 错码计数 | verify 错码一次 | 401；该记录 attempts == 1 |
| 7 | 爆破锁死 | 错码 5 次后用**正确码** verify | 401（码已废，attempts 到顶） |
| 8 | 60s 冷却 | 连续两次 send | 第二次 429 `rate_limited`；将首条 createdAt 回拨 61s 再 send → 200 |
| 9 | 24h 日限 | 直插 10 行（createdAt 分散于近 24h、均早于 60s 冷却线） | send → 429 `rate_limited` |
| 10 | 过期码 | 将码 expiresAt 回拨 1s | verify → 401 |
| 11 | 参数校验 | 非法邮箱 / code 长度非 6 | 400 `invalid_body` |

**Steps:**

- [ ] **写失败测试**：按用例表完成 email-auth.test.ts（helpers 的 `testApp`/`resetDb` 模式）
- [ ] 跑 `pnpm -C apps/api exec vitest run test/email-auth.test.ts`，预期 FAIL（404，端点不存在）
- [ ] 按契约实现 emailAuth.ts 与两个路由
- [ ] 跑 `pnpm -C apps/api exec vitest run test/email-auth.test.ts`，预期 11 用例 PASS
- [ ] rate-limit.test.ts 追加：`/auth/email/send` 连打 11 次（每次不同邮箱、伪造随机 Bearer 头）第 11 次 429——证明按 IP 计数且假头不越桶（对齐现有 `/auth/dev` 探测写法）
- [ ] public.test.ts 禁字段清单追加 `'"email"'`、`'"subject"'`，跑通全部公开端点回归
- [ ] 全量回归：两包 vitest 全绿
- [ ] Commit: `feat(api): 邮箱验证码登录端点（爆破/冷却/日限三重加固）`

---

### Task S6: 文档与部署配置收尾

**Files:**
- Modify: `CLAUDE.md`（Auth 段与公开 DTO 禁字段清单）
- Modify: `docs/deploy.md`（SMTP 环境变量）
- Modify: `compose.prod.yml`（api 服务 environment 透传 `SMTP_URL`、`MAIL_FROM`）

**Interfaces:**
- Consumes: S1–S5 落地后的实际行为。
- Produces: 与代码一致的文档；生产部署可配置发信。

**契约：**

- CLAUDE.md（英文）Auth 段改写为双 provider 事实：Identity 表为唯一凭据源（`(provider, subject)` 唯一）；Apple identityToken 与 email OTP 两条登录路径共用 `loginByIdentity` → session JWT；OTP 安全参数指向 `EMAIL_CODE` 常量；公开 DTO 禁字段清单加 `email`、`subject`。
- docs/deploy.md（中文）新增 SMTP 小节：`SMTP_URL`（smtps 连接串，留空则验证码只打印到 api 容器日志——生产必须配置）、`MAIL_FROM` 格式与发信域名 SPF/DKIM 提醒。
- compose.prod.yml 的 api 服务 environment 增加两变量透传（对齐现有 env 透传写法）。

**Steps:**

- [ ] 按契约更新三个文件
- [ ] 全量回归：两包 vitest 全绿（文档任务理应零影响，跑一遍兜底）
- [ ] Commit: `docs: 双 provider 认证说明与 SMTP 部署配置`

---

## Self-Review 记录

- **规格覆盖**：预研文档决策清单第 3 条（身份表随首个新 provider 落地）→ S1–S3；无会员 Mac 登录可用 → S4–S5；参考项目 三短板（爆破/CSPRNG/日限）→ S5 契约与用例 6–9 逐条对应；CLAUDE.md"新表进两处 TRUNCATE 清单"→ S1/S4 显式步骤。
- **占位符扫描**：全文无 TBD/TODO/"适当处理"；所有代码块均为声明式契约（schema/SQL/签名/用例表），符合本仓库"计划不含可粘贴实现代码"约束。
- **类型一致性**：`loginByIdentity` 签名在 S2（生产者）与 S5（消费者）逐字一致；`EMAIL_CODE` 常量名、`EmailCooldownError`、`normalizeEmail` 在契约与用例表间一致；`IdentityProvider` 枚举值 `APPLE`/`EMAIL` 与 seed/登录契约一致。
- **遗留声明**：客户端计划（SignInScreen 邮箱 UI、Catalyst 目标、SIWA 按钮条件隐藏、dmg 打包脚本）另立一篇，待本篇 S1–S6 全部合入后编写。
