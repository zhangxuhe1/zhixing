# 足迹照片编辑(补传/删除/排序)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 执行约定(M1 台账教训):本文只定义接口、行为、失败语义与验收标准,不内嵌可整段粘贴的业务实现代码;测试场景与关键校验语义写到可直接落笔的精度。

**Goal:** 足迹编辑器支持照片补传、删除与拖拽排序(封面=第一张);照片顺序落库,私密/公开/管理三面读取一致;删图与排序不触发重审。

**Architecture:** `FootprintPhoto` 加 `orderIndex` 列并按插入序回填;photos.ts 上传端点追加序号并收 9 张硬上限,新增单张删除与全量重排两个端点;四处照片子查询统一 orderBy。iOS 侧新增可单测的照片草稿模型 `FootprintPhotoDraft`,编辑器照片分区按"事务式草稿、保存才上行"改造保存链路;Catalyst 选图沿用 MapScreen↔Composer 的根层 photosPicker + 关闭重开舞步,状态提升到 FootprintDetailView。

**Tech Stack:** Fastify 5 + Prisma + S3 兼容存储 + vitest(真库);SwiftUI(Swift 6 / iOS 17+)+ PhotosUI + Observation + XcodeGen + XCTest。零新增第三方依赖。

**Spec:** `docs/superpowers/specs/2026-07-18-footprint-photo-editing-design.md`(状态机、重审策略、边界均以 spec 为准)

## Global Constraints

- 分支 `feat/footprint-photo-editing`(已建)。工作区遗留的 `apps/ios/project.yml` 改动与 `.claude/settings.json` **不属于本计划,任何提交不得 git add 它们**。
- 注释/commit 一律中文,conventional commits;api 端 ESM + TS strict,相对导入带 `.js`;错误形状 `{ error, detail? }`,zod 失败 400 `invalid_body`。
- 测试真库零 mock:先 `pnpm db:up`。**Task 1 之后必须 `pnpm -C packages/db push:test`**,否则测试库缺列、api 套件全线假红。`orderIndex` 是加列非新表,helpers 的 TRUNCATE 列表不动。
- 每个 api 任务收尾跑 `pnpm -C apps/api exec vitest run` 全绿再提交;每个 iOS 任务收尾跑 `scripts/ios-test.sh`(内置 `xcodegen generate`;模拟器偶发 Busy 瞬态启动失败不是测试失败,重跑即过)。
- 公开 DTO 禁字段(userId/appleSub/lat/lng/精确 takenAt/email/subject)零新增泄漏;`orderIndex` 不进任何响应体,顺序仅由数组序表达。
- 隐私铁律:`uploadPhoto` 的 `sanitized:` 参数无默认值;编辑器新增照片一律 `sanitized: false` 且不传 takenAt/lat/lng(与 Composer 调用点完全一致)。
- 重审策略(spec §3):补图/改文本重审=现状不动;**删图与排序的代码路径不得触碰 reviewStatus / publicRequestedAt**。
- 9 张上限口径全产品统一(Composer `maxSelectionCount: 9`、导入 `prefix(9)`、编辑器额度、服务端硬校验)。
- `Zhixing.xcodeproj` 是构建产物永不手改;新 Swift 文件靠 xcodegen 收录。

---

### Task 1: FootprintPhoto.orderIndex 迁移与回填(db)

**Files:**
- Modify: `packages/db/prisma/schema.prisma`(FootprintPhoto,:192-200)
- Create: `packages/db/prisma/migrations/<时间戳>_footprint_photo_order_index/migration.sql`(生成后手补回填)

**Interfaces:**
- Produces: `FootprintPhoto.orderIndex Int @default(0)`——后续所有任务依赖此列;读侧统一排序键为 `[{ orderIndex: 'asc' }, { id: 'asc' }]`(id 兜底并列值)。

- [ ] **Step 1:** schema 的 `FootprintPhoto` 在 `mediaUrl` 之后加 `orderIndex Int @default(0)`,并附中文注释:展示顺序,0 起;不加唯一约束(重排事务会经历中间态)。`@default(0)` 仅为存量迁移落列;新行由服务端显式赋值。
- [ ] **Step 2:** `pnpm --filter @zhixing/db exec prisma migrate dev --create-only --name footprint_photo_order_index`(**必须 `--create-only`**,先拿到 SQL 再改,避免"先应用后改文件"的漂移)。
- [ ] **Step 3:** 在生成的 migration.sql 加列语句之后追加回填(按 footprintId 分组、id asc≈cuid 插入序,写 0..n-1;附中文注释说明"保私密侧现状序"):

```sql
UPDATE "FootprintPhoto" p
SET "orderIndex" = t.rn - 1
FROM (
  SELECT id, row_number() OVER (PARTITION BY "footprintId" ORDER BY id) AS rn
  FROM "FootprintPhoto"
) t
WHERE p.id = t.id;
```

- [ ] **Step 4:** `pnpm --filter @zhixing/db exec prisma migrate dev` 应用(同时 prisma generate)。
- [ ] **Step 5:** `pnpm -C packages/db push:test` 同步测试库。
- [ ] **Step 6:** `pnpm test`(根目录,串行全仓)。Expected: 全绿——新列默认 0、无读者,行为零变化。
- [ ] **Step 7:** Commit:`feat(db): FootprintPhoto 加 orderIndex 列并按插入序回填`(schema + migration 两文件)。

---

### Task 2: 读序统一 + 上传追加序号与 9 张上限(api)

**Files:**
- Modify: `apps/api/src/routes/photos.ts`(:30 上传路由)
- Modify: `apps/api/src/routes/footprints.ts`(:59 FOOTPRINT_SELECT.photos)
- Modify: `apps/api/src/routes/public.ts`(:19 footprintSelect.photos、:123 photo-wall photos)
- Modify: `apps/api/src/routes/adminReview.ts`(:20 photos select)
- Modify: `apps/api/test/public.test.ts`(:137-155 photo-wall 倒序断言,有意翻转)
- Test: `apps/api/test/photos.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `orderIndex` 列。
- Produces: 上传端点新错误 `400 { error: "photo_limit_reached" }`;四处 photos 子查询全部 `orderBy: [{ orderIndex: "asc" }, { id: "asc" }]`;上传在既有事务内给新照片 `orderIndex = (当前 max ?? -1) + 1`。

- [ ] **Step 1: 写失败测试**(photos.test.ts 末尾追加,复用本文件 `multipartPayload` / `makeFootprint` / `countStorageObjects`):
  - 「照片顺序=上传顺序,私密/故事/照片墙三面一致」:alice 建足迹逐张传 3 张(记 id 序);`GET /me/footprints` 的 photos id 序=上传序;prisma 直改足迹 `PUBLIC+APPROVED` 后,`GET /places/:id/stories` 与 `GET /places/:id/photo-wall` 中该足迹照片 id 序与之完全一致(照片墙此前是 id desc,断言不再翻转);两个响应的 `JSON.stringify` 均不含字符串 `orderIndex`(spec §2:序号列不下发,顺序仅由数组序表达)。
  - 「第 10 张 400」:`prisma.footprintPhoto.createMany` 造 9 行占位(mediaUrl 任意)→ 再上传 → `400 { error: "photo_limit_reached" }`;DB 行数仍 9;`countStorageObjects` 为 0(上限校验先于 storage.put,不留孤儿对象)。
- [ ] **Step 2:** `pnpm -C apps/api exec vitest run test/photos.test.ts`。Expected: 新用例 FAIL(照片墙翻转/无上限)。
- [ ] **Step 3: 实现。**上传路由:属主 404 判定之后、`req.file()` 之前,count 该足迹照片数,≥9 → 400 `photo_limit_reached`(中文注释:与撰写器/导入的 9 张口径统一;并发竞态可短暂超限,单客户端顺序上传无感,读侧 id 兜底排序无害)。既有 `$transaction` 内 create 之前 `aggregate _max.orderIndex`,create data 加 `orderIndex: (max ?? -1) + 1`。四个 select 站点统一补 orderBy(photo-wall 删掉原 `orderBy: { id: "desc" }`)。
- [ ] **Step 4:** 同步 `public.test.ts:137-155`:photo-wall 组内序期望从「id 倒序」改为「创建序」(springPhoto1 在前);更新用例名与注释,写明这是 spec §0 的有意修复。
- [ ] **Step 5:** `pnpm -C apps/api exec vitest run`。Expected: 全绿(C1 回审等既有用例不受影响)。
- [ ] **Step 6:** Commit:`feat(api): 照片顺序落库统一读取,上传按序追加并收 9 张上限`。

---

### Task 3: DELETE /photos/:id(api)

**Files:**
- Modify: `apps/api/src/routes/photos.ts`(GET /photos/:id 之后新增路由)
- Test: `apps/api/test/photos.test.ts`

**Interfaces:**
- Produces: `DELETE /photos/:id`(requireUser)——**仅属主**可删(公开可读者不可删):photo 不存在或非属主一律 `404 { error: "not_found" }`;成功删 DB 行后 `await app.storage.remove([photo.mediaUrl])` 并吞错仅 `app.log.warn`(先 DB 后 S3:失败最多留孤儿对象;await 而非 fire-and-forget,为的是响应返回时清理已发生、测试可直接断言),响应 `204`。**全程不触碰 reviewStatus / publicRequestedAt。**

- [ ] **Step 1: 写失败测试:**
  - 属主删除:传 2 张 → DELETE 第 1 张 → 204;DB 剩 1 行且是第 2 张;`countStorageObjects(`photos/${fpId}/`)` 为 1(对象被清)。
  - 删到 0:把剩余一张也删掉 → 204;足迹本体仍在(`GET /me/footprints` 含该足迹,photos 为空数组)。
  - 非属主:bob 删 alice 的照片 → 404;行还在。
  - 宽松不重审:`PUBLIC+APPROVED` 足迹删照片 → 204;reviewStatus 仍 `APPROVED`、publicRequestedAt 原值不变(取删除前值对比断言)。
  - 不存在的 photoId → 404。
- [ ] **Step 2:** `pnpm -C apps/api exec vitest run test/photos.test.ts`。Expected: 新用例 FAIL(404 no route)。
- [ ] **Step 3: 实现。**查 photo(include footprint 只取 userId,镜像 GET :86-88 的取法但判定只认属主);中文注释点明两件事:与 GET 的差异(读允许公开面、删仅属主)、删图不回审的依据(spec §3:不引入未审内容)。
- [ ] **Step 4:** `pnpm -C apps/api exec vitest run`。Expected: 全绿。
- [ ] **Step 5:** Commit:`feat(api): 单张照片删除端点——属主校验、S3 清理、不触发重审`。

---

### Task 4: PUT /footprints/:id/photos/order(api)

**Files:**
- Modify: `apps/api/src/routes/photos.ts`
- Test: `apps/api/test/photos.test.ts`

**Interfaces:**
- Produces: `PUT /footprints/:id/photos/order`(requireUser),body `{ photoIds: string[] }`(zod:`z.object({ photoIds: z.array(z.string()) })`,解析失败 400 `invalid_body`)。语义:**全量排列**——`photoIds` 必须与该足迹现存照片集合完全相等(无重复、无缺失、无多余;判定:去重后长度=原长=现存数,且每个现存 id 都在集合中),不等 → `400 { error: "invalid_body", detail: "photo_set_mismatch" }`。通过后事务内按数组下标批量写 `orderIndex = i`,响应 204,幂等。**不触碰 reviewStatus / publicRequestedAt。**足迹不存在或非属主 → 404。0 张足迹 + `photoIds: []` 自然通过集合校验,204 no-op(不加 `min(1)`)。

- [ ] **Step 1: 写失败测试:**
  - 重排生效+幂等:3 张倒序 PUT → 204;`GET /me/footprints` photos 序=新序;同一排列再 PUT → 仍 204、序不变。
  - 集合不等三连:缺一张 / 多一个陌生 id / 含重复 id → 均 400 `invalid_body`(detail `photo_set_mismatch`);DB 顺序未变。
  - 非属主:bob 对 alice 足迹 PUT → 404。
  - 宽松不重审+公开面跟随:`PUBLIC+APPROVED` 足迹重排 → 204;reviewStatus 仍 `APPROVED`;`GET /places/:id/stories` 该足迹照片序=新序。
  - 足迹不存在 → 404。
- [ ] **Step 2:** `pnpm -C apps/api exec vitest run test/photos.test.ts`。Expected: 新用例 FAIL。
- [ ] **Step 3: 实现。**属主判定镜像上传路由(:32-35);现存 id 用 `findMany select id`;集合校验语义如上;`$transaction` 收 update 数组(每项 `where: { id: photoId }, data: { orderIndex: i }`——集合校验已保证 id 都属于该足迹)。中文注释:全量排列换来的是"校验即防越权+天然幂等";排序不回审的依据(spec §3:集合未变仅展示序)。
- [ ] **Step 4:** `pnpm -C apps/api exec vitest run`。Expected: 全绿。
- [ ] **Step 5:** Commit:`feat(api): 照片全量重排端点——集合相等校验、幂等、不触发重审`。

---

### Task 5: iOS 网络层与 Store 原语

**Files:**
- Modify: `apps/ios/Zhixing/Core/APIClient.swift`(:76 无 body 版 put 旁)
- Modify: `apps/ios/Zhixing/Core/FootprintStore.swift`(:88 uploadPhoto;文件尾新增两方法)
- Test: `apps/ios/Tests/APIClientMethodTests.swift`

**Interfaces:**
- Produces(Task 6/7/8 依赖,签名逐字):
  - `APIClient`:`func put(_ path: String, json: some Encodable) async throws`——JSON body、2xx 即成、不解析响应体(服务端 204);实现走既有 `raw(...)`,与无 body 版 `put` 并列。
  - `FootprintStore.uploadPhoto` 改为 `@discardableResult func uploadPhoto(...) async throws -> FootprintPhotoMeta`(把现在丢弃的响应体 return 出去;Composer/AlbumImporter 调用点因 `@discardableResult` 零改动)。
  - `FootprintStore`:`func deletePhoto(id: String) async throws`→ `DELETE /photos/\(id)`;`struct ReorderBody: Encodable { let photoIds: [String] }`(非私有,测试可构造,先例 UpdateBody :66);`func reorderPhotos(footprintId: String, photoIds: [String]) async throws` → `PUT /footprints/\(footprintId)/photos/order`。
  - 三个新方法**都不动本地 `footprints` 数组**——编辑器保存序列末尾统一 `await load()` 刷新(Composer :191 先例);方法注释写明这一分工。

- [ ] **Step 1: 写失败测试**(APIClientMethodTests,StubURLProtocol 惯例,镜像 patch 两用例 :118-141):`testPutWithJSONSendsBodyAndSucceedsOn2xx`(stub 204;断言 method PUT、content-type `application/json`、lastBody 解出 `photoIds` 键)与 `testPutWithJSONThrowsOnNon2xx`(stub 400 `invalid_body`;断言 APIError.status(400, 含 invalid_body))。用 `FootprintStore.ReorderBody(photoIds: ["a","b"])` 作为编码载荷,顺带钉住 body 结构。
- [ ] **Step 2:** `scripts/ios-test.sh`。Expected: 新用例编译失败(方法不存在)——iOS 侧"失败测试"以编译错为准。
- [ ] **Step 3: 实现**上述四项(uploadPhoto 内 `let meta: FootprintPhotoMeta = try await ...` 后 return)。
- [ ] **Step 4:** `scripts/ios-test.sh`。Expected: 全绿(PhotoSanitizeTests/MultipartTests 等既有用例不受影响)。
- [ ] **Step 5:** Commit:`feat(ios): 照片删除/重排网络原语,uploadPhoto 透出服务端返回的照片 id`。

---

### Task 6: 照片草稿模型 FootprintPhotoDraft(纯逻辑,可单测)

**Files:**
- Create: `apps/ios/Zhixing/Footprint/FootprintPhotoDraft.swift`
- Test: `apps/ios/Tests/FootprintPhotoDraftTests.swift`

**Interfaces:**
- Produces(Task 7/8 依赖,签名逐字;全部纯值类型、不碰网络):
  - `struct LocalPhotoDraft: Identifiable, Equatable { let id: UUID; let data: Data }`
  - `enum PhotoDraftEntry: Identifiable, Equatable { case remote(FootprintPhotoMeta); case local(LocalPhotoDraft) }`,`var id: String`(remote→meta.id;local→uuidString)。
  - `struct FootprintPhotoDraft: Equatable`:
    - `init(original: [FootprintPhotoMeta])`(entries=original 逐张 .remote)
    - 编辑操作:`mutating func append(_ local: LocalPhotoDraft)` / `mutating func remove(id: String)` / `mutating func move(id: String, toIndex: Int)`(拖拽落点)/ `mutating func moveToFront(id: String)`(设为封面)
    - 差量视图:`var pendingRemovals: [String]`(original 有而 entries 无的 remote id,按 original 序)/ `var pendingAdditions: [LocalPhotoDraft]`(entries 序)/ `var reorderNeeded: Bool`(entries 的 id 序 ≠「original 剔除 removals 的序 + additions 按 entries 序追加」——即服务器执行删/增后的自然序;不等才需要 PUT)/ `var hasChanges: Bool` / `var count: Int` / `var remainingQuota: Int`(9 − count,下限 0)
    - 进度固化(部分失败重试的正确性):`mutating func markRemoved(id: String)`(从 original 摘除→重试不再重复 DELETE)/ `mutating func markUploaded(draftId: UUID, meta: FootprintPhotoMeta)`(entries 内 local 原位替换成 remote,original 末尾追加 meta)/ `mutating func markSkipped(draftId: UUID)`(坏图从 entries 剔除)
    - `var finalPhotoIds: [String]?`——entries 全为 remote 时返回 id 排列(PUT 的 body),仍有 local 时返回 nil(表示上传未完成,不许发 PUT)。

- [ ] **Step 1: 写失败测试**(纯逻辑矩阵,每条一个用例,断言点写死):初始无变更(hasChanges=false, reorderNeeded=false);删一张(pendingRemovals 正确、reorderNeeded=false);删到 0;append 两张(pendingAdditions 序、remainingQuota 扣减、reorderNeeded=false——追加到尾=自然序);新图 move 到中间(reorderNeeded=true);moveToFront(reorderNeeded=true;对第一张 no-op 时 false);删+增+重排组合的三个差量视图联合断言;markRemoved 后 pendingRemovals 不再含它;markUploaded 后 finalPhotoIds 可产出且含新 id 于正确位置;markSkipped 后 finalPhotoIds 不含坏图、count 恢复;9 张满额 remainingQuota=0。
- [ ] **Step 2:** `scripts/ios-test.sh`。Expected: 编译失败(类型不存在)。
- [ ] **Step 3: 实现**(文件头注释:这是编辑器照片分区的"事务式草稿"核心,保存链路按 pendingRemovals→pendingAdditions→reorderNeeded 三段消费;设计依据 spec §4)。
- [ ] **Step 4:** `scripts/ios-test.sh`。Expected: 全绿。
- [ ] **Step 5:** Commit:`feat(ios): 足迹照片编辑草稿模型——差量视图与部分失败进度固化`。

---

### Task 7: 编辑器照片分区 UI 与保存链路(非 Catalyst 全功能)

**Files:**
- Modify: `apps/ios/Zhixing/Footprint/FootprintEditor.swift`
- Test: `apps/ios/Tests/FootprintEditorPhotoTests.swift`(新建,源码断言惯例,先例 PhotoGridTests :36-52)

**Interfaces:**
- Consumes: Task 5 store 原语、Task 6 草稿模型。
- Produces: 编辑器 Form 新增 `Section("照片")`(插在「地点」之后,对齐 Composer 区序);`@State private var draft: FootprintPhotoDraft`(init 以 `footprint.photos` 建);保存链路按 spec §4 的 ①②③④。

**行为定义(实现按此落笔,不贴整段代码):**
- 宫格:LazyVGrid 3 列、间距 4、格 1:1 圆角 8;**定框写法必须 `Color.clear` + `.aspectRatio` + 图作 overlay + clip**(PhotoWallSection:93-100 踩坑约定);`ForEach(draft.entries)` 以 entry.id 为身份(严禁 `\.offset`)。remote 格渲染 `AuthedPhotoView(photoId:)`;local 格渲染 `UIImage(data:)` 的 Image(resizable + scaledToFill),右下角「待上传」小角标。
- 删除:每格右上 ✕ 角标按钮(本任务两端常显;Catalyst 悬停显隐在 Task 8 收窄),点击 `draft.remove(id:)`;每格 contextMenu:「设为封面」(`moveToFront`)与「删除」(role: .destructive)。
- 拖拽:格 `.draggable(entry.id)`(String 天然 Transferable)+ 格 `.dropDestination(for: String.self)`,落到格 i → `draft.move(id:, toIndex: i)`。
- "+"格:`draft.remainingQuota > 0` 才渲染,虚线圆角框加号;`#if !targetEnvironment(macCatalyst)` 内联 `PhotosPicker(selection: $pickerItems, maxSelectionCount: draft.remainingQuota, selectionBehavior: .ordered, matching: .images)`(Catalyst 分支 Task 8 接 `onChoosePhotos`)。`onChange(of: pickerItems)`:Task 内逐项 `loadTransferable(type: Data.self)`,成功 `draft.append(LocalPhotoDraft(id: UUID(), data: data))`,读不出的计数;处理完清空 `pickerItems`,有跳过则 `errorMessage = "有 N 张照片无法读取,已跳过"`。
- Diff 扩展:`hasChanges` 改为「字段 diff ‖ draft.hasChanges」(保存按钮启用条件);`needsReReviewWarning` 的内容变更条件扩为「text/date 变更 ‖ !draft.pendingAdditions.isEmpty」——**仅新增照片算内容变更,删图/排序不算**(spec §3/§4),注释写明依据。
- performSave 序列(哪步 throw 停哪步,errorMessage 展示、编辑器留在原地、草稿因进度固化不重复已成步骤):
  ① 字段 diff 非空才调既有 `store.update`;
  ② `for id in draft.pendingRemovals`:`store.deletePhoto(id:)` 成功即 `draft.markRemoved(id:)`(**② 必须先于 ③:满 9 张删旧补新要靠先删才过服务端上限**,注释点明);
  ③ `for local in draft.pendingAdditions`:`store.uploadPhoto(footprintId:, imageData: local.data, sanitized: false)` 成功 `draft.markUploaded(draftId:, meta:)`;`catch is PhotoTranscodeError` → `draft.markSkipped(draftId:)` 并记序号(镜像 Composer :185-188 的跳过语义);其他错误上抛停链;
  ④ `draft.reorderNeeded`,且 `draft.finalPhotoIds` 非 nil 时才 `store.reorderPhotos(footprintId:, photoIds:)`;
  ⑤ `await store.load()`;无跳过则 dismiss,有跳过则弹「部分照片未能上传」点名弹窗、点「好」再 dismiss(镜像 Composer :105-112 / :192-197)。

- [ ] **Step 1: 写失败测试**(FootprintEditorPhotoTests,对 `Footprint/FootprintEditor.swift` 源码断言):contains `Color.clear`、`.draggable(`、`.dropDestination(`、`sanitized: false`、`"设为封面"`、`markRemoved`(进度固化确实接入保存链路);NOT contains `id: \.offset`、`takenAt:`(编辑器上传不许带任何照片 meta)。
- [ ] **Step 2:** `scripts/ios-test.sh`。Expected: 新测试 FAIL(源码尚无这些标记)。
- [ ] **Step 3: 实现**上述行为(照片分区可拆为文件内 private 子 View 保持 body 可读)。
- [ ] **Step 4:** `scripts/ios-test.sh`。Expected: 全绿(含 Task 6 的草稿矩阵)。
- [ ] **Step 5:** Commit:`feat(ios): 编辑器照片分区——补传/删除/拖拽排序与事务式保存链路`。

---

### Task 8: Catalyst 选图提升与悬停细节

**Files:**
- Modify: `apps/ios/Zhixing/Footprint/FootprintDetailView.swift`(:76 sheet 处 + 视图根层)
- Modify: `apps/ios/Zhixing/Footprint/FootprintEditor.swift`(#if 分支 init 与"+"格)
- Test: `apps/ios/Tests/FootprintEditorPhotoTests.swift`(追加源码断言)

**Interfaces:**
- Consumes: MapScreen↔Composer 的既有舞步先例(`MapScreen.swift:80-117`:根层 `.photosPicker` + `.photosPickerStyle(.presentation)` + 关闭重开 restore flag;`FootprintComposer.swift:8-48`:Catalyst 专属 init 把全部表单状态提升为 Binding)。
- Produces: `FootprintEditor` Catalyst 专属 init(镜像 Composer):`init(footprint:, text: Binding<String>, date: Binding<Date>, isPublic: Binding<Bool>, draft: Binding<FootprintPhotoDraft>, error: Binding<String?>, onChoosePhotos: @escaping (Int) -> Void)`——Int 为当前 `draft.remainingQuota`;非 Catalyst init 保持 `init(footprint:)` 不变;内部 `@State`/`@Binding` 用 `#if targetEnvironment(macCatalyst)` 切换(Composer :8-23 先例)。

**行为定义:**
- FootprintDetailView(仅 Catalyst 分支)持有编辑器全部状态:text/date/isPublic/error/draft/pickerItems/showEditorPhotoPicker/editorPickerLimit/restore flag——**必须全部提升**:选图舞步会关闭编辑器 sheet,`@State` 留在 sheet 内就会丢草稿(Composer 提升 7 项状态就是为此)。
- 根层挂 `.photosPicker(isPresented:, selection: $pickerItems, maxSelectionCount: editorPickerLimit, selectionBehavior: .ordered, matching: .images)` + `.photosPickerStyle(.presentation)`;`onChoosePhotos(limit)` → 记 limit、立 restore flag、关编辑器 sheet、开 picker;picker 关闭且 restore flag 立着 → 重开编辑器 sheet(镜像 MapScreen :109-116 的 onChange 舞步)。
- `pickerItems` → `draft.append` 的装载逻辑(loadTransferable + 跳过点名 + 清空 items)在 Catalyst 下放 FootprintDetailView 侧(sheet 关闭期间 picker 返回也能装上,重开即见);与 Task 7 编辑器内联版行为一致,仅位置不同。
- 编辑器 sheet 正常关闭(保存成功/取消,非 restore 流程)时,detail 侧重置全部提升状态,避免下次打开残留(Composer 的 `handleComposerDismissed` 先例,MapScreen :80)。
- 悬停:✕ 角标在 Catalyst 用 `.onHover` 控制显隐(Mac 原生惯例),iOS 保持常显;右键 contextMenu Catalyst 天然可用。
- FootprintDetailView 的两个入口(MeScreen:47、MyMapScreen:219 的 NavigationLink)无需改动——提升状态都在 detail view 自身。

- [ ] **Step 1: 写失败测试**(追加到 FootprintEditorPhotoTests):FootprintDetailView.swift contains `.photosPickerStyle(.presentation)`、`maxSelectionCount: editorPickerLimit`;FootprintEditor.swift contains `onChoosePhotos`、`.onHover`。
- [ ] **Step 2:** `scripts/ios-test.sh`。Expected: 新断言 FAIL。
- [ ] **Step 3: 实现**上述行为。
- [ ] **Step 4:** `scripts/ios-test.sh`。Expected: 全绿。
- [ ] **Step 5:** Commit:`feat(ios): Catalyst 编辑器选图提升到详情页根层,悬停显隐删除角标`。

---

### Task 9: 全量回归、真机链路验证与走查交接

**Files:** 无新改动(发现问题回对应任务修)。

- [ ] **Step 1:** `pnpm test`(根目录串行全仓)+ `scripts/ios-test.sh`。Expected: 全绿。
- [ ] **Step 2: API 级端到端抽查**(dev 环境 `ZHIXING_DEV_AUTH=1` 起 api,curl 走完整链路;每步写预期):`POST /auth/dev` 拿 token → 建足迹 → 逐张传 3 图(201,id 记序)→ `GET /me/footprints`(photos 序=上传序)→ DELETE 中间张(204)→ PUT 倒序(204)→ 再 GET(序=新序)→ prisma/管理端把足迹置 `PUBLIC+APPROVED` → 再删一张+重排 → `GET /places/:id/stories` 足迹仍在且序跟随(宽松不掉公开面)→ 第 10 张上传得 400 `photo_limit_reached`。
- [ ] **Step 3: Mac 端走查交接。**构建启动 Catalyst 版(先 `pgrep` 清同名旧实例再起,ad-hoc 签名覆写,产物 Debug-maccatalyst;API 指本地)。osascript 无辅助访问权限,UI 驱动走查交用户人工执行,给出清单:① 打开一条多图足迹的编辑器,照片分区显示现有照片;② "+"补传两张,出现「待上传」角标,选图器占满窗口且关闭后编辑器带草稿重开;③ 拖一张到首位/右键「设为封面」;④ 悬停出 ✕ 删一张;⑤ 保存后详情页宫格即时更新;⑥ 已公开足迹删图/排序后仍在公开面;⑦ 已公开足迹补图时弹「修改后将重新审核」。
- [ ] **Step 4:** 走查问题清零后,用 superpowers:finishing-a-development-branch 交用户定分支去向(push/合并留给用户)。
