# 足迹图片编辑（新增 / 删除 / 替换）Implementation Plan

> 执行约定：按任务顺序逐项勾选；每个任务先写失败测试，再实现，再跑受影响测试。本文只定义产品、接口、状态机、失败语义和验收标准，不包含可直接粘贴的业务实现代码。

**Goal:** 让用户在既有足迹的编辑页查看和管理照片，支持新增、删除与替换；保持默认私密、公开内容变更重新审核、照片 EXIF 脱敏和对象存储清理等既有安全契约。

**Architecture:** 继续使用现有 `FootprintPhoto` 模型和 `POST /footprints/:id/photos` 上传链路，不做数据库迁移。服务端新增单图删除端点；iOS 编辑页维护本地图片草稿，点击“保存”后按安全顺序执行上传、删除和足迹字段 PATCH，成功后统一刷新 `FootprintStore`。替换在协议层拆成“先上传新图、成功后删除旧图”，不新增专用替换端点。

**Tech Stack:** Fastify 5 + Prisma + S3 兼容存储 + vitest；SwiftUI + PhotosUI + Observation + XcodeGen；零新增第三方依赖。

## 1. 当前实现与缺口

- `FootprintPhoto` 已是独立模型，包含 `id / footprintId / mediaUrl / takenAt / lat / lng`，随足迹级联删除。
- 新建足迹和相册导入均限制每条最多 9 张照片；iOS 会在上传前重编码 JPEG、剥离 EXIF。
- `POST /footprints/:id/photos` 已支持给任意属于自己的既有足迹新增照片；PUBLIC 足迹新增照片会回 `PENDING`。
- `GET /photos/:id` 已支持属主读取，以及其他登录用户读取 `PUBLIC + APPROVED` 照片；`AuthedPhotoView` 可直接复用。
- `FootprintEditor` 当前只编辑 `text / date / visibility`；没有照片草稿或管理 UI。
- 服务端没有单张照片删除端点，因此目前无法完整实现删除或替换。

## 2. 本期范围

### 2.1 纳入

- 编辑页展示全部已有照片。
- 从系统照片选择器新增照片，保存前可移除待上传照片。
- 标记删除已有照片，保存前可撤销。
- 将某张已有照片替换为新照片。
- 保存时展示进度，部分失败时明确提示并允许只重试未完成操作。
- PUBLIC 足迹发生任意图片增删后回 `PENDING`，已公开内容立即从旅人故事和照片墙消失，等待重新审核。
- 删除数据库照片记录后，尽力清理 MinIO / S3 对象。
- iPhone/iPad 与 Mac Catalyst 共用实现。

### 2.2 不纳入

- 照片排序、拖拽调整顺序。
- 指定封面、照片标题、说明文字。
- 裁剪、旋转、滤镜或原图编辑。
- 批量选择已有照片后一键删除。
- 服务端原子批量编辑端点。
- 修改相册批量导入流程。
- 数据库 schema 迁移。

## 3. 产品与状态机决策

### 3.1 图片数量

- 保存后的目标状态最多 9 张，与撰写器和相册导入保持一致。
- 编辑页的“添加照片”可选数量按 `9 - 保存后仍保留的已有照片数 - 已暂存新增数` 动态计算。
- 替换一张照片不增加目标总数；协议执行期间允许短暂出现第 10 张，因为必须先上传新图，不能先删原图。
- 若历史数据意外超过 9 张，仍允许删除和替换，但在降到 9 张以内前不允许继续新增。
- 本期不在服务端强制 9 张硬上限：现有上传 API 允许追加，而安全替换在满 9 张时需要短暂超限。服务端资源上限和原子替换协议另立硬化任务处理。

### 3.2 是否允许零照片

- 允许用户删完全部照片；足迹仍保留地点、日期以及可选文字。
- 理由：服务端创建接口本就允许无文字、无照片，相册导入在照片全部失败时也可能留下仅有地点和日期的足迹。若要强制“文字或照片至少一个”，应作为独立的数据不变量治理任务，同时修正创建、导入和编辑三条路径，本期不局部加规则。

### 3.3 草稿与取消

- 打开编辑页后，已有照片、待新增照片、待删除照片均只存在本地草稿中。
- 点击“取消”或下滑关闭，不调用任何图片写接口，远端保持不变。
- 新选照片在进入草稿时读取原始 Data，并立即调用 `preparedPhotoUploadData(raw, sanitized: false)` 产出 EXIF-free JPEG；草稿只保存脱敏后的 JPEG 与预览图，不长期持有含 EXIF 原始字节。无法读取或转码的项目立即剔除并提示，不等到保存阶段才发现。
- 已有照片标记删除后从主网格淡出，并提供“撤销移除”；保存成功前不真正删除。

### 3.4 替换语义

- UI 提供明确的“更换”动作；内部记录为一对 `旧 photoId -> 新本地照片`。
- 保存时先上传新照片；只有新照片上传成功后，才删除对应旧照片。
- 如果上传失败，旧照片不动。
- 如果新照片上传成功但删除旧照片失败，页面保留“旧照片待删除”状态并提示部分成功；重试时只执行删除，不重复上传新照片。

### 3.5 公开审核语义

- 他人可见的唯一判据保持 `visibility = PUBLIC && reviewStatus = APPROVED`。
- PUBLIC 足迹新增、删除或替换任一照片，都视为内容变更：`reviewStatus = PENDING`、`publicRequestedAt = now()`。
- 已公开足迹存在图片或文字/日期变更时，保存前沿用“修改后将重新审核”提醒。
- PRIVATE → PUBLIC：先在私密态完成文字、日期和图片变更，全部成功后最后切 PUBLIC，保证审核队列看到最终内容。
- PUBLIC → PRIVATE：先把足迹切 PRIVATE，再执行图片变更，保证撤回公开立即生效，也避免无意义地重新入队。
- visibility 未变化且保持 PUBLIC：图片写操作会立即回 PENDING；文字/日期 PATCH 放在图片操作之后，使最终队列时间覆盖全部成功变更。

## 4. API 契约

### 4.1 新增端点

`DELETE /photos/:id`

- 鉴权：`requireUser`。
- 请求体：无。
- 属主校验：照片不存在或照片所属足迹不属于当前用户，统一返回 `404 { error: "not_found" }`，不泄露资源存在性。
- 成功：返回 204，无响应体。
- 数据库事务：
  1. 删除 `FootprintPhoto` 记录；
  2. 若所属足迹当前为 PUBLIC，同一事务把 `reviewStatus` 改为 `PENDING` 并刷新 `publicRequestedAt`。
- 对象存储：数据库事务提交后调用 `storage.remove([mediaUrl])`。失败只记录包含 `photoId / footprintId` 的 warning，不回滚已经成功的数据库删除；照片授权入口已失效，不会继续对用户可见。
- 幂等取舍：不做幂等删除；第二次删除返回 404，与现有足迹删除和资源隐藏策略一致。

### 4.2 既有上传端点保持

`POST /footprints/:id/photos`

- 请求和响应结构不变，继续返回 `{ id, takenAt }`。
- 继续执行 MIME、15MB、meta zod 校验和 PUBLIC 回 PENDING 逻辑。
- 不新增原始 EXIF 上传路径；编辑器在选择阶段用 `preparedPhotoUploadData(raw, sanitized: false)` 生成脱敏 JPEG，保存阶段调用 `uploadPhoto(..., sanitized: true)` 避免二次有损压缩。

## 5. iOS 客户端契约

### 5.1 `FootprintStore`

- 将 `uploadPhoto(...)` 调整为 `@discardableResult` 并返回服务端已有的 `FootprintPhotoMeta`，供编辑器在部分成功后准确记录新 `photoId`；撰写器和相册导入可继续忽略返回值。
- 新增 `deletePhoto(photoId:) async throws`，调用 `DELETE /photos/:id`。
- 新增可抛错的 `refreshFootprints()`：只刷新足迹列表；既有 `load()` 内部可继续以 `try?` 调它并保持“失败保留旧值”的页面加载语义。编辑保存使用可抛错版本，避免远端已经成功但列表刷新失败却被静默吞掉。
- 图片批次完成或失败收敛后调用一次 `refreshFootprints()`，刷新照片数组、审核徽标和公开状态；不为每张照片重复拉取全部足迹，也不额外刷新不受影响的 stats。
- `deletePhoto` 失败不得从本地 Store 假删，沿用整条足迹删除的真实性原则。

### 5.2 编辑页图片草稿

建议在 `apps/ios/Zhixing/Footprint/` 新建纯状态文件 `FootprintPhotoEditDraft.swift`，避免把差异计算和保存编排全部塞进 SwiftUI View。

草稿至少表达：

- 原始远端照片列表。
- 已标记删除的 photoId 集合。
- 待新增的本地照片，使用稳定 UUID 标识，并持有上传用 JPEG Data 与本地预览图。
- 替换关系 `旧 photoId -> 新本地照片 UUID`。
- 计算属性：`hasChanges`、`finalPhotoCount`、`remainingCapacity`、`photoChanged`。
- 操作成功后的收敛方法：上传成功记录新远端 photoId；删除成功移除旧 photoId；失败项目保持待执行，重试不会重复上传或删除。

### 5.3 编辑页 UI

- 在“地点”和“这一刻”之间增加“照片”Section。
- 已有照片使用 `AuthedPhotoView` 显示方形缩略图；每张提供“更换”和“移除”。
- 待新增照片显示本地预览和移除按钮；不通过 presigned URL 回读刚选照片。
- 末尾提供“添加照片”卡片，使用 `PhotosPicker`，动态限制剩余容量。
- 图片数量为 9 时隐藏或禁用新增入口，但仍允许更换与删除。
- 被标记移除的照片支持撤销；替换中的旧图显示明确状态，避免用户误以为已经远端生效。
- `保存` 的启用条件扩展为“文字/日期/公开状态/图片任一有变更”。
- 保存期间冻结表单与关闭手势，显示现有 toolbar `ProgressView`。
- 已公开足迹只要 `photoChanged == true`，也进入现有重新审核确认分支。

### 5.4 保存编排与部分失败

保存顺序必须由纯计划函数计算并单测锁定：

1. **PUBLIC → PRIVATE**：先 PATCH（可同时带文字/日期和 `visibility: PRIVATE`）→ 上传全部新图 → 删除普通移除图及已成功替换的旧图。
2. **PRIVATE → PUBLIC**：先 PATCH 文字/日期（不带 visibility）→ 上传全部新图 → 删除普通移除图及已成功替换的旧图 → 最后 PATCH `visibility: PUBLIC`。
3. **visibility 不变**：上传全部新图 → 删除普通移除图及已成功替换的旧图 → 最后 PATCH 有变化的文字/日期。
4. 所有分支都保证“上传成功的新图”先于“它要替换的旧图删除”。
5. 任一步失败即停止后续依赖步骤；已成功步骤写回本地 baseline 并从 pending 队列移除。
6. 失败后尝试执行 `store.refreshFootprints()`，编辑页保持打开，提示“部分改动已保存”，列出已完成和待重试数量；再次点击保存只执行剩余步骤。
7. 全部远端写操作成功后执行 `store.refreshFootprints()`；刷新成功才自动关闭。若刷新失败，提示“改动已保存，但列表刷新失败”，不得把已完成操作重新放回 pending，也不得重复上传。

本期接受跨 HTTP 请求无法整体回滚的现实，但必须做到：不重复上传、不因替换失败丢原图、不把用户已成功的远端改动伪装成未发生。

## 6. 任务拆分

### Task P1：单图删除 API 与审核状态机

**Files:**

- Modify: `apps/api/src/routes/photos.ts`
- Modify: `apps/api/test/photos.test.ts`

**测试用例：**

| # | 场景 | 断言 |
|---|---|---|
| 1 | 属主删除私密足迹照片 | 204；DB 记录删除；`GET /photos/:id` 变 404；MinIO 对象不存在 |
| 2 | 非属主删除 | 404；DB 和 MinIO 均保留 |
| 3 | 删除不存在照片 | 404 |
| 4 | PUBLIC+APPROVED 删除照片 | 204；足迹回 PENDING；`publicRequestedAt` 刷新；从 stories/photo-wall 消失 |
| 5 | PRIVATE 删除照片 | `reviewStatus/publicRequestedAt` 原样保留 |
| 6 | PUBLIC+REJECTED 删除照片 | 回 PENDING，形成重新提交 |

**Steps:**

- [ ] 在 `photos.test.ts` 写上述失败测试；复用真实测试 MinIO 和 `countStorageObjects`
- [ ] 跑 `pnpm -C apps/api exec vitest run test/photos.test.ts`，确认新测试因 DELETE 路由缺失而失败
- [ ] 在 `photos.ts` 实现属主查询、事务删除、PUBLIC 回 PENDING、事务后对象清理
- [ ] 跑 `pnpm -C apps/api exec vitest run test/photos.test.ts`，确认通过
- [ ] 跑 `pnpm -C apps/api exec vitest run`，确认 API 全量通过
- [ ] Commit: `feat(api): 支持删除足迹单张照片并触发公开重审`

---

### Task P2：iOS 图片草稿与保存计划纯逻辑

**Files:**

- Create: `apps/ios/Zhixing/Footprint/FootprintPhotoEditDraft.swift`
- Create: `apps/ios/Tests/FootprintPhotoEditDraftTests.swift`

**测试用例：**

| # | 场景 | 断言 |
|---|---|---|
| 1 | 新增普通照片 | `hasChanges=true`；目标数量 +1；容量 -1 |
| 2 | 标记删除后撤销 | 最终差异为空；容量恢复 |
| 3 | 满 9 张替换 1 张 | 目标总数仍为 9；允许执行 |
| 4 | 历史照片 >9 | 禁止新增；仍允许删除/替换 |
| 5 | 替换计划 | 新图 upload 步骤严格早于旧图 delete 步骤 |
| 6 | PRIVATE→PUBLIC | visibility PUBLIC 是最后一步 |
| 7 | PUBLIC→PRIVATE | visibility PRIVATE 是第一步 |
| 8 | PUBLIC 不变且内容+图片都改 | 图片操作先执行，文字/日期 PATCH 最后执行 |
| 9 | 上传成功后删除失败 | 新 photoId 已进入 baseline；重试计划不再包含 upload，只包含旧图 delete |
| 10 | 取消 | 草稿销毁即可，无远端操作步骤被执行 |

**Steps:**

- [ ] 写草稿和保存计划的失败测试，测试不发网络请求
- [ ] 跑 `scripts/ios-test.sh`，确认新测试失败
- [ ] 实现纯状态与步骤排序；不在此任务接 SwiftUI 或 API
- [ ] `cd apps/ios && xcodegen generate`
- [ ] 跑 `scripts/ios-test.sh`，确认通过
- [ ] Commit: `feat(ios): 建立足迹图片编辑草稿与保存编排`

---

### Task P3：`FootprintStore` 图片增删能力

**Files:**

- Modify: `apps/ios/Zhixing/Core/FootprintStore.swift`
- Modify as needed: `apps/ios/Tests/APIClientMethodTests.swift`

**行为契约：**

- `uploadPhoto` 返回 `FootprintPhotoMeta`，且保持现有 EXIF 脱敏、meta 字段和错误行为不变。
- `deletePhoto(photoId:)` 只在服务端 2xx 后返回成功；非 2xx 原样上抛。
- `refreshFootprints()` 失败向上抛错、成功原子替换 `footprints`；现有 `load()` 的容错外观不变。
- 撰写器和相册导入的调用行为及统计不变。

**测试用例：**

| # | 场景 | 断言 |
|---|---|---|
| 1 | `uploadPhoto` 收到 201 meta | 返回解码后的 `FootprintPhotoMeta.id`，请求仍为 multipart POST |
| 2 | `deletePhoto("ph1")` 收到 204 | 方法为 DELETE、路径为 `/photos/ph1`、无 body |
| 3 | `deletePhoto` 收到非 2xx | 原样抛 `APIError.status` |
| 4 | `refreshFootprints` 成功 | 用响应完整替换 `footprints` |
| 5 | `refreshFootprints` 失败 | 向上抛错且保留刷新前列表，不清空旧值 |

**Steps:**

- [ ] 在 `APIClientMethodTests.swift` 增加上表失败测试，复用 `StubURLProtocol`
- [ ] 调整 `uploadPhoto` 返回类型，新增 `deletePhoto` 与可抛错的 `refreshFootprints`
- [ ] 更新 `preparedPhotoUploadData` / `uploadPhoto` 注释，把“编辑草稿自产的 EXIF-free JPEG”列为合法的 `sanitized: true` 调用方
- [ ] 编译确认 `FootprintComposer`、`AlbumImporter` 既有调用点无回归
- [ ] 跑 `scripts/ios-test.sh`
- [ ] Commit: `feat(ios): 补齐足迹照片上传回执与单图删除能力`

---

### Task P4：编辑页照片管理 UI 与保存闭环

**Files:**

- Modify: `apps/ios/Zhixing/Footprint/FootprintEditor.swift`
- Reuse unchanged: `apps/ios/Zhixing/Footprint/AuthedPhotoView.swift`
- Modify as needed: `apps/ios/Tests/FootprintPhotoEditDraftTests.swift`

**Steps:**

- [ ] 在编辑页加入已有照片网格、添加入口、本地预览、移除/撤销和更换动作
- [ ] 选择阶段用 `preparedPhotoUploadData(raw, sanitized: false)` 生成 EXIF-free 上传数据；坏图立即提示并不进入草稿，保存时以 `sanitized: true` 上传避免二次压缩
- [ ] 将图片差异纳入保存按钮启用条件和已公开重审提醒
- [ ] 接入 P2 保存计划与 P3 Store 方法，逐步收敛成功操作
- [ ] 实现部分成功提示、剩余操作重试和成功后 `store.refreshFootprints()` + dismiss；刷新失败不得重复提交已完成写操作
- [ ] 保存期间冻结表单、照片选择和关闭手势
- [ ] `cd apps/ios && xcodegen generate`
- [ ] 跑 `scripts/ios-test.sh`
- [ ] 跑 Catalyst Debug 构建；需要人工走查时使用 `scripts/mac-dev.sh`
- [ ] Commit: `feat(ios): 在足迹编辑页支持新增删除与替换照片`

---

### Task P5：端到端验收与文档收尾

**自动验证：**

- [ ] `pnpm -C apps/api exec vitest run`
- [ ] `scripts/ios-test.sh`
- [ ] `cd apps/ios && xcodegen generate && xcodebuild -project Zhixing.xcodeproj -scheme Zhixing -configuration Debug -destination 'generic/platform=macOS,variant=Mac Catalyst' -derivedDataPath DerivedData/mac-photo-edit CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=- build`

**人工验收矩阵：**

- [ ] 私密足迹：新增 1 张，保存、重开后仍存在
- [ ] 私密足迹：删除 1 张，保存、重开后消失；旧 photoId 返回 404
- [ ] 私密足迹：更换 1 张；断网导致新图上传失败时原图仍在
- [ ] 满 9 张足迹：不可继续新增，但可以更换或删除
- [ ] 编辑后点取消：远端照片完全不变
- [ ] PUBLIC+APPROVED：增、删、换任一照片都会先提示重新审核；保存后徽标为“审核中”，他人故事/照片墙不可见
- [ ] PUBLIC+REJECTED：修改照片后回“审核中”
- [ ] PUBLIC→PRIVATE 同时改照片：先撤回公开，不显示重新审核误导
- [ ] PRIVATE→PUBLIC 同时改照片：图片全部完成后才提交公开，审核队列看到最终内容
- [ ] 模拟中途失败：页面明确显示部分成功；重试不重复上传已成功照片
- [ ] iPhone 模拟器与 Mac Catalyst 均能选择、预览、删除和替换照片

**收尾：**

- [ ] 复核公开 DTO 仍不包含 `mediaUrl / lat / lng / takenAt` 等敏感字段
- [ ] 复核没有修改 `packageManager`，没有手改或提交 `Zhixing.xcodeproj`
- [ ] 在本计划勾选实际完成项，并记录任何偏差及原因
- [ ] Final commit（仅在 P1–P4 未分别提交时使用）：`feat: 完成足迹图片编辑闭环`

## 7. 风险与控制

| 风险 | 控制 |
|---|---|
| 替换时先删旧图导致数据丢失 | 强制先上传新图，成功后才删旧图，并用纯计划测试锁定顺序 |
| 多请求部分成功造成重复上传 | 每个成功步骤立即从 pending 中移除并写回 baseline；重试只跑剩余步骤 |
| 审核通过后偷换图片 | 上传和删除端点都在 PUBLIC 状态下原子回 PENDING |
| 切 PRIVATE 时仍被重排审核 | visibility PRIVATE 作为第一步，后续图片接口看到的是私密态 |
| 切 PUBLIC 时审核到半成品 | visibility PUBLIC 作为最后一步 |
| 删除 DB 成功但 S3 删除失败 | 用户授权面立即失效；记录 warning，后续可用孤儿对象巡检清理 |
| EXIF/GPS 泄露 | 编辑器沿用原始选择 `sanitized: false` 的重编码路径；不增加原图直传分支 |
| Catalyst 照片选择行为不同 | P4 强制 Catalyst 构建，P5 要求 Mac 实机走查 |

## 8. 完成定义

只有同时满足以下条件才算完成：

1. 用户可以在既有足迹中新增、删除和替换照片，取消不会产生远端修改。
2. 替换上传失败不会丢失原图；部分成功可见、可恢复、重试不重复。
3. 公开足迹的任何图片变更都重新审核，且审核前不出现在公开故事或照片墙。
4. 删除后数据库记录和正常情况下的对象存储文件都被清理，越权删除统一 404。
5. API 全量测试、iOS 全量测试、Catalyst 构建和人工验收矩阵全部通过。
