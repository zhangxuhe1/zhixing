# 知行 Mac 桌面版（Catalyst）+ dmg 分发 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把知行 iOS App 构建为 Mac Catalyst 桌面版并打包 dmg 分发给朋友小圈子，同时补齐邮箱验证码登录 UI（Mac 唯一正规登录路径）与部署前硬化清单代码项。

**Architecture:** 客户端三块顺序推进——邮箱登录 UI（iOS/Mac 共用，走与 SIWA 相同的 SessionStore/Keychain 通道）→ Catalyst 工程改造（entitlements 按 SDK 分叉，SIWA 编译期裁剪）→ dmg 打包脚本（ad-hoc 签名，留 Developer ID 升级钩子）。服务端硬化三项（启动断言/compose 健康检查/统一错误形状）独立于客户端，先做，使 VPS 部署（用户主导，走 docs/deploy.md）可并行。

**Tech Stack:** SwiftUI（Swift 6, iOS 17+ / macOS 14+ Catalyst）+ XcodeGen + xcodebuild/hdiutil；服务端 Fastify 5 + vitest。**零新增依赖。**

**规格：** docs/superpowers/specs/2026-07-12-mac-catalyst-dmg-design.md（已评审修订版）。服务端邮箱 OTP 已由 2026-07-12-email-otp-identity-server.md 完成，本篇不动服务端登录逻辑。

## 背景与决策记录（执行者无对话上下文，此节自包含）

- **无 Apple 会员 → ad-hoc 签名**：SIWA 的 `com.apple.developer.applesignin` entitlement 签不进 ad-hoc 构建（Mac 构建直接失败），故 entitlements 必须按 SDK 分叉，且 Mac 上 SIWA 按钮要编译期裁掉——**Mac 版唯一正规登录 = 邮箱验证码**。ad-hoc（`CODE_SIGN_IDENTITY="-"`）是 Apple Silicon 可启动的最低要求，无需证书。
- **工程默认 `CODE_SIGN_STYLE: Automatic` 且无 Team**：Mac 构建必须**同时覆写** `CODE_SIGN_STYLE=Manual` 与 `CODE_SIGN_IDENTITY="-"`，只覆写后者会先死在"缺 development team"。
- **版本号探针结论（已实证）**：XcodeGen 生成的 Info.plist 把 `CFBundleShortVersionString` 硬编码为 1.0——只加 `MARKETING_VERSION` 构建设置流不进产物，必须同步在 `info.properties` 写 `CFBundleShortVersionString: $(MARKETING_VERSION)`。dmg 产物命名依赖真实版本号。
- **服务端错误面故意合并（防爆破，勿为 UI 拆开）**：冷却/日限统一 429 `rate_limited`，错码/过期/锁死统一 401 `invalid_code`，均无细分信息。客户端**只按 HTTP status 映射**中文文案、绝不解析 body（authRateLimit 插件的 429 体形与 `{error}` 不同，按 status 判别对两种体形都稳）。
- **send 成功仅返回 `{ok:true}`、不下发冷却秒数**：客户端自带倒计时常量，取值与服务端 `EMAIL_CODE.cooldownMs`（60s）一致，两边注释互指，改参数时同步。
- **Keychain 跨版本风险（写进安装说明，代码勿动）**：ad-hoc 签名的 designated requirement 绑二进制 hash、逐版本变化——升级新版后旧 token 条目会触发系统钥匙串授权弹窗或读不到（表现为升级即登出）；v0.1 单版本无感。现有 Keychain.swift 不用 data-protection keychain 的写法在 ad-hoc 下是唯一可行解（改用会 -34018 缺 application-identifier），**勿动**。
- **Gatekeeper 放行主路径 = `xattr -dr com.apple.quarantine`**：ad-hoc + quarantine 在 Apple Silicon 上大概率弹「已损坏」对话框（无"仍要打开"通道）；"系统设置 → 仍要打开"是 Intel 机器可能出现的备路径。最终文案以验收第 1 步干净环境实测为准。U 盘/scp 拷贝不带 quarantine，可完全绕开。
- **部署前硬化清单**（docs/deploy.md 标注"首次部署时执行"）代码项纳入本计划：compose.prod.yml 的 db healthcheck 与 api 对 db 的 `service_healthy` 依赖**已存在**，只缺 minio healthcheck + api 对 minio 的依赖收紧；photos.test.ts:247 的 413 用例只断言状态码不断言体形，统一错误形状不会破坏它。
- **启动断言必须门在生产**：本地 dev 就是靠 config.ts 的 dev 默认值零配置起跑的，断言无条件生效会废掉 `pnpm --filter @zhixing/api dev`。方案：compose.prod.yml 给 api 注入 `NODE_ENV: production`，server.ts 仅在该值下断言；buildApp 不动，测试零波及。

## Global Constraints

- **本计划只定义接口与行为，不含可粘贴的实现代码**（M1 台账教训）。代码块仅限：声明式配置（YAML/plist）、TS/Swift 类型与签名、端点/命令契约、测试用例表。实现由实现者按契约编写，审查者按契约验收。
- pnpm 钉 `10.34.4`（勿动 packageManager 字段）；Node >= 22；ESM + `.js` 后缀相对导入；TS strict。
- 错误响应统一 `{ error: string, detail?: any }`；body 校验一律 zod，失败 400 `invalid_body`。
- commit 信息中文、conventional commits，尾行 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- **project.yml 是唯一工程真源**：改动后必须 `xcodegen generate`；Zhixing.xcodeproj 是构建产物，永不手改、不入库。
- **测试不动原则**：ZhixingTests 继续只跑 iOS 模拟器（scripts/ios-test.sh 原样）；不为 Mac 新建测试 target。Catalyst 侧保障 = dmg 脚本 Release 构建成功 + C7 人工走查。
- api 任务收尾跑 `pnpm -C apps/api exec vitest run`；iOS 任务收尾跑 `scripts/ios-test.sh`；全绿才 commit。
- iOS 单测内环可用 `-only-testing` 加速（在 apps/ios 下）：`xcodebuild -project Zhixing.xcodeproj -scheme Zhixing -destination "platform=iOS Simulator,name=<可用 iPhone 模拟器>" test -only-testing:ZhixingTests/<类名>`；commit 前仍须整套 scripts/ios-test.sh。
- Catalyst 构建验证命令（Debug，ad-hoc 覆写；在 apps/ios 下）：`xcodebuild -project Zhixing.xcodeproj -scheme Zhixing -configuration Debug -destination 'generic/platform=macOS,variant=Mac Catalyst' -derivedDataPath DerivedData/mac-debug CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=- build`
- 客户端倒计时常量与服务端 `EMAIL_CODE.cooldownMs`（apps/api/src/emailAuth.ts，60s）取值一致，**注释互指**，改参数两边同步。
- 客户端错误呈现只按 HTTP status 映射，禁止解析响应 body 字符串。
- Keychain.swift 现有写法勿动（见背景）。

**任务依赖**：H1→H2→H3（服务端硬化，先做，使用户可并行开始部署）；C1→C2→C3（邮箱登录 UI）→C4（Catalyst）→C5（dmg）→C6（安装说明）→C7（走查）；A1 最后（依赖用户侧 VPS/DNS/SMTP 就绪 + C5 产物）。

---

### Task H1: 生产启动断言（弱密钥拒绝启动）

**Files:**
- Create: `apps/api/src/prodGuard.ts`
- Create: `apps/api/test/prod-guard.test.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `compose.prod.yml`（api.environment 增 `NODE_ENV: production`）
- Modify: `docs/deploy.md`（硬化清单"启动断言"项勾选并注明实现位置）

**Interfaces:**
- Consumes: `config`（apps/api/src/config.ts 现有导出）。
- Produces:

```ts
// apps/api/src/prodGuard.ts
export function findWeakSecrets(secrets: {
  SESSION_SECRET: string;
  ADMIN_TOKEN: string;
  S3_SECRET_KEY: string;
}): string[];
```

**行为契约：**

- 弱值判定（对每个值 trim 后比较）：空串、`change-me`、`dev-session-secret`、`dev-admin-token`、`zhixing-secret` 任一命中即弱。返回命中的键名数组（按对象键序）；全强则空数组。弱值集合与 config.ts 的 dev 默认值、.env.production.example 的占位值一一对应——**compose 缺变量时 `${VAR}` 替换成空串，config.ts 的 `??` 捕不到，这正是空串必须入列的原因**（写进文件头注释）。
- server.ts：仅 `process.env.NODE_ENV === "production"` 时调用，传 `config.sessionSecret` / `config.adminToken` / `config.s3.secretKey`；返回非空 → `console.error` 列出键名并提示"在 .env.production 设为强随机值（openssl rand -hex 24）"→ `process.exit(1)`，不 listen。
- buildApp 不动——vitest 与本地 dev（NODE_ENV 未设）零影响。
- compose.prod.yml 仅在 api.environment 增一行 `NODE_ENV: production`（带注释指向 prodGuard.ts）。

**测试用例表**（`test/prod-guard.test.ts`，纯函数测试，不连库、不 buildApp）：

| # | 输入 | 期望 |
|---|------|------|
| 1 | 三值均为强随机串 | `[]` |
| 2 | SESSION_SECRET=`dev-session-secret`，余强 | `["SESSION_SECRET"]` |
| 3 | ADMIN_TOKEN=`change-me`，余强 | `["ADMIN_TOKEN"]` |
| 4 | S3_SECRET_KEY=`""`，余强 | `["S3_SECRET_KEY"]` |
| 5 | S3_SECRET_KEY=`zhixing-secret`，余强 | `["S3_SECRET_KEY"]` |
| 6 | ADMIN_TOKEN=`"  "`（纯空白），余强 | `["ADMIN_TOKEN"]` |
| 7 | 三值分别为 `dev-session-secret`/`dev-admin-token`/`change-me` | 三键全列出 |

**Steps:**

- [x] 写失败测试 `apps/api/test/prod-guard.test.ts`（上表 7 用例）
- [x] 跑 `pnpm -C apps/api exec vitest run test/prod-guard.test.ts`，预期 FAIL（模块不存在）
- [x] 实现 `src/prodGuard.ts` 并接入 `src/server.ts`（NODE_ENV 门 + exit(1) 契约）
- [x] 跑 `pnpm -C apps/api exec vitest run test/prod-guard.test.ts`，预期 PASS
- [x] compose.prod.yml api.environment 增 `NODE_ENV: production`；`docker compose -f compose.prod.yml --env-file .env.production config >/dev/null` 退出码 0
- [x] docs/deploy.md 硬化清单"启动断言"项标为已完成（注明 src/prodGuard.ts + server.ts）
- [x] 全量回归 `pnpm -C apps/api exec vitest run` 全绿
- [x] Commit: `feat(api,ops): 生产启动断言——弱密钥拒绝启动（部署前硬化 1/3）`

---

### Task H2: compose 健康检查补全（minio healthcheck + api 依赖收紧）

db 的 healthcheck 与 api 对 db 的 `service_healthy` 依赖已存在，本任务只补 minio 一侧。

**Files:**
- Modify: `compose.prod.yml`
- Modify: `docs/deploy.md`（硬化清单"compose 健康检查"项勾选）

**声明式契约**（compose.prod.yml 增量）：

```yaml
  minio:
    healthcheck:
      test: ["CMD", "mc", "ready", "local"]   # minio/minio 镜像内置 mc；ready local 为官方推荐探活
      interval: 5s
      timeout: 3s
      retries: 12

  api:
    depends_on:
      db: { condition: service_healthy }       # 已存在，保持
      minio: { condition: service_healthy }    # service_started → service_healthy
```

**Steps:**

- [ ] 按契约修改 compose.prod.yml（minio 增 healthcheck；api.depends_on.minio 改 `service_healthy`）
- [ ] 验证：`docker compose -f compose.prod.yml --env-file .env.production config` 退出码 0，渲染输出含 db/minio 两处 healthcheck 且 api 两个依赖均为 service_healthy
- [ ] docs/deploy.md 硬化清单"compose 健康检查"项标为已完成
- [ ] Commit: `fix(ops): compose 健康检查补全（部署前硬化 2/3）`

---

### Task H3: 统一错误形状（框架级 404/413/500 收敛为 `{error}`）

**Files:**
- Modify: `apps/api/src/app.ts`（buildApp 内、Fastify 实例创建后注册 setNotFoundHandler / setErrorHandler）
- Create: `apps/api/test/error-shape.test.ts`
- Modify: `docs/deploy.md`（硬化清单"统一错误形状"项勾选）

**行为契约**（映射表）：

| 触发 | status | body |
|------|--------|------|
| 未匹配路由（setNotFoundHandler） | 404 | `{error:"not_found"}` |
| body 超限（fastify bodyLimit 默认 1MiB）/ multipart 文件超 15MB——凡 `statusCode===413` | 413 | `{error:"payload_too_large"}` |
| 框架级 400（如 JSON 解析失败） | 400 | `{error:"invalid_body"}`（对齐既有约定） |
| 其余 `err.statusCode` ∈ [400,500) | 原状态码 | `{error:"request_error"}` |
| `statusCode` ≥ 500 或缺失 | 500 | `{error:"internal_error"}`，并 `req.log.error(err)` 留完整堆栈 |

注意事项（写进 handler 注释）：

- 路由内手写的 `reply.code().send({error})` 不经过 errorHandler，零波及；
- @fastify/rate-limit 的 429 由插件自答、不经 errorHandler，体形保持现状——客户端按 status 判别（见规格与 iOS EmailAuthRules 注释）；
- **5xx 响应绝不回显 `err.message`**（防内部信息/堆栈泄漏），细节只进日志。

**测试用例表**（`test/error-shape.test.ts`，沿用 helpers.testApp 模式）：

| # | 注入 | 期望 |
|---|------|------|
| 1 | `GET /definitely-not-a-route` | 404 + body 恰为 `{error:"not_found"}` |
| 2 | `POST /auth/email/send`，content-type json，payload 为 2MiB 字符串字段 | 413 + `{error:"payload_too_large"}` |
| 3 | 另起 buildApp 注册临时路由 `GET /boom`（handler 直接 `throw new Error("秘密堆栈信息")`），注入之 | 500 + body 恰为 `{error:"internal_error"}` 且不含"秘密堆栈"字样 |

**Steps:**

- [ ] 写失败测试 `apps/api/test/error-shape.test.ts`（上表 3 用例；用例 3 记得 finally close 临时 app）
- [ ] 跑 `pnpm -C apps/api exec vitest run test/error-shape.test.ts`，预期 FAIL（404 是 fastify 默认体形）
- [ ] 在 app.ts 按契约实现两个 handler
- [ ] 跑 `pnpm -C apps/api exec vitest run test/error-shape.test.ts`，预期 PASS
- [ ] 全量回归 `pnpm -C apps/api exec vitest run` 全绿（重点：photos.test.ts 的 413 用例、rate-limit.test.ts 均不应受影响）
- [ ] docs/deploy.md 硬化清单"统一错误形状"项标为已完成
- [ ] Commit: `feat(api): 统一错误形状——框架级 404/413/500 收敛（部署前硬化 3/3）`

> 硬化清单第 4 项"备份含 MinIO 卷"是 VPS 上的 crontab 操作，deploy.md 已有带命令的核对项，无代码改动，归 A1 用户侧执行。

---

### Task C1: SessionStore 邮箱登录端点方法

**Files:**
- Modify: `apps/ios/Zhixing/Core/SessionStore.swift`
- Create: `apps/ios/Tests/EmailAuthTests.swift`

**Interfaces:**
- Consumes: `APIClient.shared.post(_:json:)`、私有 `apply(_: AuthResponse)`（均现有）；测试复用 `Tests/APIClientMethodTests.swift` 里的 `StubURLProtocol`（同 target 内 internal 可见，勿复制粘贴第二份）。
- Produces（SessionStore，@MainActor）：

```swift
func sendEmailCode(email: String) async throws
func signInWithEmail(email: String, code: String) async throws
```

> 规格原文写"APIClient 增加两个端点方法"，此处按代码库既有模式落在 SessionStore——认证端点方法（signInWithApple/devLogin）历来住这里，且 verify 成功必须走 SessionStore 私有的 `apply()`（Keychain 存储路径）。APIClient 保持纯通用 HTTP 层，不加业务端点。

**行为契约：**

- `sendEmailCode`：POST `/auth/email/send`，body `{email}`；成功仅要求 `{ok:true}` 可解码（私有 Decodable 结构体），无返回值。注释注明：服务端契约见 apps/api/src/routes/auth.ts，**成功不下发冷却秒数**，倒计时由客户端常量驱动（C2）。
- `signInWithEmail`：POST `/auth/email/verify`，body `{email, code}`；成功解码 `AuthResponse` 后走**与 SIWA 完全相同**的 `apply()`（token 入 Keychain + APIClient.shared.token），后续请求无差别。
- 失败一律上抛 `APIError.status`——中文文案映射不在本层（C2 的 EmailAuthRules 负责）。
- 入参邮箱由调用方（C3 视图层）trim 后传入，本层不重复校验（服务端还有 normalizeEmail 兜底）。
- body 结构体仿照现有 `AppleBody`/`DevBody` 私有嵌套写法。

**测试用例表**（`Tests/EmailAuthTests.swift`，setUp/tearDown 照抄 APIClientMethodTests 的 StubURLProtocol 注册/清理模式）：

| # | stub | 动作 | 断言 |
|---|------|------|------|
| 1 | 200 `{"ok":true}` | `sendEmailCode(email:"friend@example.com")` | lastRequest path==`/auth/email/send`、method POST、content-type application/json、body JSON 的 email 字段回读相等 |
| 2 | 200 `{"token":"jwt-123","user":{"id":"u1","nickname":"测试"}}` | 新建 SessionStore，`signInWithEmail(email:…, code:"123456")`；**defer session.signOut()**（清 Keychain 与 APIClient.shared.token，防污染其他用例） | lastRequest path==`/auth/email/verify`；`session.token=="jwt-123"`；`isSignedIn==true` |
| 3 | 401 `{"error":"invalid_code"}` | `signInWithEmail(…, code:"000000")` | 抛 `APIError.status(401,_)`；`session.token` 仍为 nil |

**Steps:**

- [ ] 写失败测试 `Tests/EmailAuthTests.swift`（上表 3 用例）
- [ ] 内环跑 `-only-testing:ZhixingTests/EmailAuthTests`，预期 FAIL（方法不存在 → 编译失败即红）
- [ ] 在 SessionStore 按契约实现两方法
- [ ] 内环重跑，预期 PASS
- [ ] 整套 `scripts/ios-test.sh` 全绿
- [ ] Commit: `feat(ios): SessionStore 邮箱验证码登录端点（与 SIWA 同一 Keychain 通道）`

---

### Task C2: 邮箱登录纯逻辑（本地校验 + 倒计时状态机 + 错误映射）

**Files:**
- Create: `apps/ios/Zhixing/Auth/EmailSignInSection.swift`（本任务只放纯逻辑；C3 在同文件追加视图——规格指定单文件）
- Create: `apps/ios/Tests/EmailSignInLogicTests.swift`
- Modify: `apps/api/src/emailAuth.ts`（**仅注释**：`cooldownMs` 行加一句"客户端倒计时常量与此同步：apps/ios/Zhixing/Auth/EmailSignInSection.swift"，完成注释互指）

**Interfaces:**
- Consumes: `APIError`（Core/APIClient.swift 现有）。
- Produces（C3 视图与其单测使用）：

```swift
enum EmailAuthRules {
    static let cooldownSeconds = 60                    // 与服务端 EMAIL_CODE.cooldownMs 一致，注释互指
    static func isValidEmail(_ raw: String) -> Bool    // trim 后宽校验 local@domain.tld
    static func isValidCode(_ raw: String) -> Bool     // 恰为 6 位数字
    static func message(for error: Error) -> String    // 仅按 HTTP status 映射中文文案
}

struct SendCooldown {                                  // 时间显式注入，无隐式 Date()，可单测
    mutating func start(now: Date)
    func remaining(now: Date) -> Int                   // 剩余秒数，向上取整，非负
    func isCoolingDown(now: Date) -> Bool
}
```

**行为契约：**

- `isValidEmail`：trim 首尾空白后须整串匹配「非空 local@非空 domain.非空 TLD、各段不含空白与 @」的宽校验；严格校验交给服务端 zod。`isValidCode`：整串恰为 6 位数字（与 `EMAIL_CODE.length` 一致）。
- `message(for:)`：`APIError.status(429,_)` →「操作太频繁，请稍后再试」（冷却或日限，服务端不区分、无剩余秒数）；`APIError.status(401,_)` →「验证码错误或已失效，请重新获取」（错码/过期/锁死，服务端不区分）；其余一切（含 400、URLError 等）→「操作失败，请检查网络后重试」。**注释写明**：服务端故意合并错误面（防爆破，见 apps/api/src/emailAuth.ts），且 authRateLimit 插件的 429 体形与 `{error}` 不同——按 status 判别对两种体形都稳，**禁止解析 body**。
- `SendCooldown`：`start(now:)` 记截止时刻 = now + cooldownSeconds；`remaining(now:)` = 截止减 now 向上取整到秒、到期后恒 0；`isCoolingDown` = remaining > 0。未 start 时 remaining 恒 0。

**测试用例表**（`Tests/EmailSignInLogicTests.swift`）：

| # | 用例 | 断言 |
|---|------|------|
| 1 | 邮箱校验 | `a@b.co` ✓；`"  a@b.co  "` ✓（trim）；`""`、`ab.co`、`a@b`（无 TLD）、`a @b.co`（内部空白）均 ✗ |
| 2 | 验证码校验 | `012345` ✓；`12345`、`1234567`、`12345a`、`""` 均 ✗ |
| 3 | 倒计时状态机（固定 t0 注入） | 初始 remaining==0、非冷却；start 后 remaining(t0)==60；t0+59.5 时 remaining==1（向上取整）；t0+59.9 仍冷却；t0+60 起不冷却、remaining==0 |
| 4 | 错误映射只看 status | 429 配 `{error}` 体与 429 配 authRateLimit 异形体 → 同一文案；401 → 对应文案；400 与 `URLError(.notConnectedToInternet)` → 兜底文案 |

**Steps:**

- [ ] 写失败测试 `Tests/EmailSignInLogicTests.swift`（上表 4 组）
- [ ] 内环跑 `-only-testing:ZhixingTests/EmailSignInLogicTests`，预期 FAIL（类型不存在）
- [ ] 创建 `Auth/EmailSignInSection.swift` 实现 EmailAuthRules 与 SendCooldown（含互指注释）
- [ ] 内环重跑，预期 PASS
- [ ] apps/api/src/emailAuth.ts `cooldownMs` 注释补客户端回指（跑 `pnpm -C apps/api exec vitest run` 确认注释改动无碍）
- [ ] 整套 `scripts/ios-test.sh` 全绿
- [ ] Commit: `feat(ios): 邮箱登录纯逻辑——校验/倒计时/错误映射（与服务端参数注释互指）`

---

### Task C3: EmailSignInSection 视图 + SignInScreen 组装（Catalyst 编译期裁剪 SIWA）

**Files:**
- Modify: `apps/ios/Zhixing/Auth/EmailSignInSection.swift`（追加 View）
- Modify: `apps/ios/Zhixing/Auth/SignInScreen.swift`

**Interfaces:**
- Consumes: `EmailAuthRules` / `SendCooldown`（C2）、`SessionStore.sendEmailCode` / `signInWithEmail`（C1）。
- Produces: `struct EmailSignInSection: View`（无参数，经 `@Environment(SessionStore.self)` 取会话）。

**EmailSignInSection 行为契约：**

- 布局：邮箱行（TextField + 发送按钮）＋验证码行（TextField + 登录按钮）＋红色 footnote 错误文案，风格对齐 SignInScreen 现状（.textFieldStyle(.roundedBorder)、水平 padding 40）。
- 发送按钮：disabled = 发送请求进行中 ∨ 冷却中 ∨ `!isValidEmail(email)`；标题冷却中为「重新发送(N秒)」、否则「发送验证码」；点击 → trim 邮箱 → `sendEmailCode` → 成功 `cooldown.start(now:)`、失败 `EmailAuthRules.message` 上屏。
- 登录按钮：disabled = 验证进行中 ∨ `!isValidCode(code)`；点击 → `signInWithEmail`（邮箱同样 trim）→ 成功**无需任何导航**（`session.isSignedIn` 翻转由 RootView 自动切主界面）、失败同上映射上屏。
- 倒计时驱动：`Timer.publish(every: 1, on: .main, in: .common).autoconnect()` + `.onReceive` 刷新 `@State now`，所有 SendCooldown 调用显式传 now。
- 输入配置：邮箱 `textContentType(.emailAddress)` + `keyboardType(.emailAddress)` + `textInputAutocapitalization(.never)` + `autocorrectionDisabled()`；验证码 `keyboardType(.numberPad)`。

**SignInScreen 组装契约：**

- SIWA 按钮块、`handle(_:)` 方法、`import AuthenticationServices` 整体包进 `#if !targetEnvironment(macCatalyst)`（ad-hoc 签不进 applesignin entitlement，按钮留着只会报错）；同分支内、SIWA 按钮之下加分隔文案「或使用邮箱验证码登录」（.footnote/.secondary）——Mac 上邮箱是唯一入口，不显示"或"。
- `EmailSignInSection()` 两平台都渲染，位于 SIWA 块之后、DEBUG 开发登录按钮之前；开发登录按钮维持现状（仅 DEBUG 可见）。

**Steps:**

- [ ] 在 EmailSignInSection.swift 追加视图实现；改造 SignInScreen
- [ ] 整套 `scripts/ios-test.sh` 全绿（视图层不新增单测，逻辑已由 C2 覆盖；本步同时验证 iOS 侧编译）
- [ ] 真流程烟测（模拟器 + 本地 api）：`pnpm db:up` → `pnpm --filter @zhixing/api dev`（SMTP 未配 → 验证码打印到 api 控制台）→ 模拟器起 App → 输邮箱发码 → 从 api 控制台读码 → 登录成功进主界面；再点发送验证一次冷却倒计时在跑
- [ ] 冷启动重开模拟器 App，确认邮箱登录态经 Keychain 恢复（restore 路径）
- [ ] Commit: `feat(ios): 邮箱验证码登录 UI（Catalyst 编译期裁剪 SIWA，iOS 双登录并存）`

---

### Task C4: Catalyst 工程改造（目标 + entitlements 分叉 + 版本号 + 窗口最小尺寸）

**Files:**
- Modify: `apps/ios/project.yml`
- Create: `apps/ios/Zhixing/ZhixingMac.entitlements`
- Modify: `apps/ios/Zhixing/App/ZhixingApp.swift`

**声明式契约（project.yml 增量，Zhixing target）：**

```yaml
targets:
  Zhixing:
    type: application
    supportedDestinations: [iOS, macCatalyst]   # 取代 platform: iOS（两者互斥，删旧行）
    settings:
      base:
        MARKETING_VERSION: 0.1.0
        # Catalyst 走 macosx SDK，条件精确命中：Mac 构建用无 SIWA 的 entitlements，iOS 不受影响
        CODE_SIGN_ENTITLEMENTS[sdk=macosx*]: Zhixing/ZhixingMac.entitlements
    info:
      properties:
        # XcodeGen 硬编码版本号 1.0，只加构建设置流不进产物（探针已实证）——必须显式引用
        CFBundleShortVersionString: $(MARKETING_VERSION)
```

其余（PRODUCT_BUNDLE_IDENTIFIER、entitlements.path 指向 Zhixing.entitlements 等）保持不动；ZhixingTests target 保持 `platform: iOS` 不动。

**ZhixingMac.entitlements**：合法 plist、根为空 dict（无 applesignin，无沙箱——ad-hoc 非商店分发不需要）。

**窗口最小尺寸契约（ZhixingApp.swift）：**

```swift
#if targetEnvironment(macCatalyst)
private static func applyWindowSizeRestrictions()
#endif
```

- 行为：遍历 `UIApplication.shared.connectedScenes`，对每个 `UIWindowScene` 设 `sizeRestrictions?.minimumSize = 1000×700`（防窗口拖成手机条状致地图不可用）；挂载于 WindowGroup 内容的 `.onAppear`，整段 `#if targetEnvironment(macCatalyst)` 包裹（postfix `#if` 修饰符链，Swift 5.5+ 语法）。

**Steps:**

- [ ] 按契约修改 project.yml、新建 ZhixingMac.entitlements、改 ZhixingApp.swift
- [ ] `xcodegen generate` 成功
- [ ] Catalyst Debug 构建成功（Global Constraints 里的验证命令）
- [ ] 版本号断言：`/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' DerivedData/mac-debug/Build/Products/Debug-maccatalyst/Zhixing.app/Contents/Info.plist` 输出 `0.1.0`
- [ ] entitlements 断言：`codesign -d --entitlements - DerivedData/mac-debug/Build/Products/Debug-maccatalyst/Zhixing.app` 输出**不含** `applesignin`
- [ ] iOS 回归：整套 `scripts/ios-test.sh` 全绿
- [ ] Commit: `feat(ios): Mac Catalyst 目标——entitlements 按 SDK 分叉 + 版本号 0.1.0 + 窗口最小 1000×700`

---

### Task C5: dmg 打包脚本 `scripts/mac-dmg.sh`

**Files:**
- Create: `scripts/mac-dmg.sh`（可执行位，风格对齐 scripts/ios-test.sh：`set -euo pipefail`、cd 到脚本相对路径）

**命令契约**（顺序即脚本骨架；产物路径 `dist/`、中间产物 `apps/ios/DerivedData/` 均已被根 .gitignore 覆盖）：

1. `ROOT` 取仓库根（脚本所在目录的上级），`cd "$ROOT/apps/ios"`，`xcodegen generate`；
2. Release 构建（`APP_API_BASE` 由 release 档自动取 `https://api.example.com`，无需覆写）：

   ```sh
   xcodebuild -project Zhixing.xcodeproj -scheme Zhixing -configuration Release \
     -destination 'generic/platform=macOS,variant=Mac Catalyst' \
     -derivedDataPath DerivedData/mac \
     CODE_SIGN_STYLE=Manual "CODE_SIGN_IDENTITY=${MAC_SIGN_IDENTITY:--}" \
     build
   ```

   注释写明：默认 ad-hoc（`-`）；两个覆写缺一不可（工程默认 Automatic 且无 Team，不覆写先死在"缺 development team"）；
3. 产物 `DerivedData/mac/Build/Products/Release-maccatalyst/Zhixing.app`；版本号用 PlistBuddy 读产物 `Contents/Info.plist` 的 `CFBundleShortVersionString`（不读 project.yml——以产物为准）；
4. 装盘布局：mktemp 暂存目录（trap EXIT 清理），`cp -R` 产物为 `知行.app`（**装盘前重命名，不破坏签名**；与 docs/mac-install.md 的路径/xattr 命令对齐），`ln -s /Applications` 快捷方式；
5. `hdiutil create -volname "知行" -srcfolder <暂存目录> -ov -format UDZO "$ROOT/dist/Zhixing-<版本号>.dmg"`（先 `mkdir -p dist`）；
6. 升级钩子：`MAC_SIGN_IDENTITY` 非空时（Developer ID 路线）追加 `xcrun notarytool submit <dmg> --keychain-profile "$NOTARY_PROFILE" --wait` + `xcrun stapler staple <dmg>`；`NOTARY_PROFILE` 未设则报错退出（`${NOTARY_PROFILE:?…}`）。未设 `MAC_SIGN_IDENTITY` 走 ad-hoc，跳过公证。脚本头注释写明：将来办会员后设两个环境变量即零改动升级为可公开分发版；
7. 末行 echo dmg 绝对路径。

**Steps:**

- [ ] 按契约实现脚本，`chmod +x scripts/mac-dmg.sh`
- [ ] 运行 `scripts/mac-dmg.sh`（不设 MAC_SIGN_IDENTITY），预期生成 `dist/Zhixing-0.1.0.dmg`
- [ ] 验证 dmg：`hdiutil attach dist/Zhixing-0.1.0.dmg` → 卷内含 `知行.app` 与 `Applications` 符号链接 → `codesign -dv "/Volumes/知行/知行.app" 2>&1` 输出含 `Signature=adhoc` → `hdiutil detach`
- [ ] `git status` 确认 dist/ 与 DerivedData/ 未被跟踪
- [ ] Commit: `feat(ios): Mac dmg 打包脚本（ad-hoc 默认，Developer ID+公证钩子）`

---

### Task C6: 安装说明 `docs/mac-install.md`

**Files:**
- Create: `docs/mac-install.md`（直接发给朋友的中文文档，口吻面向非技术用户，命令逐步可照抄）

**内容契约**（按序成节；放行一节的措辞在 A1 验收第 1 步实测后定稿，文中先以显眼的「待实测确认」标注）：

1. **系统要求**：macOS 14 Sonoma 及以上（Apple Silicon 或 Intel 均可）；
2. **安装**：打开 dmg → 把「知行」拖进「应用程序」；
3. **首次打开放行**（重点，逐步描述 + 解释原因是"未做 Apple 公证的个人开发内测版"，只需操作一次）：
   - 主路径（Apple Silicon 大概率）：弹「"知行"已损坏，无法打开」——该对话框**没有**"仍要打开"通道，解法是终端执行一行 `xattr -dr com.apple.quarantine /Applications/知行.app` 后正常双击；
   - 备路径（Intel 机器可能）：弹「无法验证开发者」类对话框 → 系统设置 → 隐私与安全性 → 拉到底点「仍要打开」→ 输密码；
   - 两段均标注「最终以实测弹窗为准」占位符，A1 定稿；
4. **零门槛备选**：quarantine 只在浏览器/网盘/AirDrop 等下载途径被打上——**U 盘或 scp 拷贝的 dmg 没有这道关卡**，可完全跳过放行步骤（小圈子分发优先推荐）；
5. **使用提示**：邮箱验证码注册登录（无需 Apple 账号）；批量导入读取的是 Mac「照片」App 图库——未开 iCloud 照片的用户图库可能为空，建议开启 iCloud 照片同步（刚开启后同步很慢，可能要等较久才有图）；
6. **升级须知（预期管理）**：升级新版本后若弹系统钥匙串授权框或被登出，属预期行为（内测版签名逐版本变化所致），重新登录即可。

**Steps:**

- [ ] 按内容契约撰写 docs/mac-install.md
- [ ] 自查：文中 App 路径/名称与 C5 脚本产物一致（`/Applications/知行.app`、`Zhixing-0.1.0.dmg`）；xattr 命令可整行复制执行
- [ ] Commit: `docs: Mac 版安装说明（放行文案待验收实测定稿）`

---

### Task C7: Catalyst 核心流程走查（人工参与，只修阻断性问题）

> 本任务需要真人操作 Mac App。执行者负责搭环境、陪跑清单、修复阻断性问题（崩溃/点不到/功能不可用）；**观感问题只记录不修**，留给后续"桌面级体验"计划。

**Files:**
- Modify（如走查发现阻断性问题）: 对应 Swift 源文件
- Modify: 本计划文件末尾「走查记录」一节（新建，记录通过项与遗留观感问题清单）

**环境**：`pnpm db:up` → `pnpm --filter @zhixing/api dev`（Debug 构建指向 localhost:8787，Mac 直连本机）→ Catalyst Debug 构建（C4 验证命令）→ `open DerivedData/mac-debug/Build/Products/Debug-maccatalyst/Zhixing.app`。

**走查清单**（按序，覆盖规格"最小桌面适配"第 2、3 条）：

- [ ] 窗口：尝试把窗口拖小，最小停在 1000×700
- [ ] 邮箱验证码登录成功（码从本地 api 控制台读）
- [ ] **退出重开 App，登录态仍在**——Keychain 在 Catalyst 上的首个真实读写路径
- [ ] 地图浏览、风物卡打开可读
- [ ] 发足迹：搜索选点与「当前位置」各试一次（CoreLocation 首次授权弹窗行为与 iOS 不同，预检点）
- [ ] 批量导入：读 Mac「照片」App 图库（本版核心卖点；PHPhotoLibrary 授权 + 空图库提示核对）
- [ ] 我的页各入口点得开
- [ ] 阻断性问题当场修复（修完重跑 `scripts/ios-test.sh` 防 iOS 回归），观感问题记入走查记录
- [ ] Commit（如有代码修复）: `fix(ios): Catalyst 走查阻断性问题修复`；走查记录随本计划文件一并提交

---

### Task A1: VPS 部署配合 + 端到端验收【用户主导，执行者配合】

> 前置（只能用户本人做）：VPS 采购、DNS 三条 A 记录（api / admin / s3）、SMTP 发信账号（含 SPF/DKIM，否则验证码邮件进垃圾箱）。部署主体走 docs/deploy.md（H1–H3 已把硬化清单代码项做完）。

**环境变量核对**（.env.production，deploy.md 已有清单，此处强调三点）：`TRUST_PROXY=1`（Caddy 反代后必开）；`ZHIXING_DEV_AUTH` **绝不设置**；`SMTP_URL` / `MAIL_FROM` 配好。

**Steps:**

- [ ] 【用户】VPS/DNS/SMTP 就绪，按 docs/deploy.md 完成部署（含 H1 断言首启验证：故意留 change-me 应拒启，换强随机值后正常）
- [ ] 【用户】备份 crontab 含 MinIO 卷（deploy.md 硬化清单第 4 项，含现成命令）
- [ ] 内容数据：按 docs/content-ops.md 本地生成复核后 `pg_dump` 整库上传、TRUNCATE 测试用户数据——朋友打开地图第一眼要有风物卡内容
- [ ] 验收 1（干净环境：另一台 Mac 或本机新建用户账户）：挂载 dmg → 拖装 → 按 docs/mac-install.md 放行；**记录实际弹窗形态（「已损坏」还是「无法验证开发者」），据此定稿 mac-install.md 放行段落并去掉「待实测确认」标注**
- [ ] 验收 2：邮箱验证码真实送达（QQ / 163 / Gmail 各测一个，确认不进垃圾箱）→ 登录成功
- [ ] 验收 3：地图有内容、风物卡可读、发足迹、Mac 照片库批量导入全流程可用
- [ ] 验收 4：admin 控制台看到新用户与足迹数据
- [ ] Commit: `docs: mac-install 放行文案按实测定稿`
- [ ] 全过 → dmg 发朋友 🎉

---

## 非目标（后续另立计划）

- 桌面级体验：NavigationSplitView 宽屏侧栏、悬停态、菜单栏快捷键；
- Developer ID 签名 + 公证的公开分发（等 Apple 会员，C5 已留钩子）；
- Mac 专属测试 target。
