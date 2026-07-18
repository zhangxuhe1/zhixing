# 足迹照片编辑设计(补传 / 删除 / 排序)

日期:2026-07-18 | 状态:已与用户逐节确认
上游:产品规格书 [2026-07-06-zhixing-design.md](2026-07-06-zhixing-design.md);M2 设计 [2026-07-07-m2-design.md](2026-07-07-m2-design.md)(§3 公开状态机)
背景:足迹编辑器(`FootprintEditor`)现只支持文本/日期/可见性三项;照片在足迹创建后完全不可变。

## 0. 目标与非目标

目标(用户确认的三场景,一次做齐):
① 补传漏选的照片 ② 删除拍糊/多余的照片 ③ 调整顺序/换封面(封面 = 第一张,不设独立封面字段)

非目标:
- 地点编辑(明确暂不做);
- 照片替换/裁剪/滤镜类编辑;
- 补传照片的 EXIF 元数据入库(takenAt/坐标一律不带,同 Composer 手动撰写路径);
- 补传照片反向修改足迹的日期/地点。

顺带修复一个现存不一致:公开照片墙查询 `orderBy id desc`(cuid 递增 = 最新在前),公开故事与私密侧则无 orderBy(依赖 DB 返回序,≈插入序但无保证)。若不修,补传的新照片会在照片墙抢占该足迹首图,与本人私密侧所见相反;故事面与私密面的顺序也一直靠未定义行为撑着。

## 1. 数据模型

`FootprintPhoto` 加列 `orderIndex Int @default(0)`(无新表,测试 TRUNCATE 列表不动)。

- 迁移回填:按 `footprintId` 分组、`id asc`(cuid ≈ 插入序)写 0..n-1——私密侧现有顺序原样保留;公开侧从"最新在前"翻转为同一顺序,视为修 bug,一次性生效。
- `@default(0)` 仅为迁移落列需要;新照片的 orderIndex 由服务端在事务内取 max+1 显式赋值(追加到末尾)。
- 读取一律 `orderBy: [{ orderIndex: 'asc' }, { id: 'asc' }]`(id 兜底并列值,防并发上传撞号)。

## 2. API(均在 routes/photos.ts,requireUser + 属主校验沿用现有惯例)

| 端点 | 变更 | 行为 |
|------|------|------|
| `POST /footprints/:id/photos` | 改 | 事务内 orderIndex = max+1;新增上限校验:现存 ≥9 张时 400(对齐 Composer `maxSelectionCount: 9` 与导入 `prefix(9)` 的产品上限,防绕过);公开态回审逻辑保持不动;响应仍返 `{ id, takenAt }` |
| `DELETE /photos/:id` | 新增 | 属主校验(错误码沿用 `GET /photos/:id` 惯例)→ 删 DB 行 → `storage.remove([mediaUrl])`。先 DB 后 S3,镜像删足迹路由:S3 失败最多留孤儿对象,不留悬空行;成功响应形状同样镜像删足迹路由。**不触发重审** |
| `PUT /footprints/:id/photos/order` | 新增 | body `{ photoIds: string[] }` 全量排列;与该足迹现存照片集合不完全相等 → 400 `invalid_body`;事务内批量写 orderIndex 0..n-1;幂等;**不触发重审** |

查询统一:全部四处照片子查询改为 §1 的 orderBy——footprints.ts `FOOTPRINT_SELECT`(私密三路由共用)、public.ts `footprintSelect`(故事列表/故事详情)、public.ts 照片墙查询、adminReview.ts 审核队列(管理员所见顺序与公开面一致,审核所见即所得)。公开 DTO 字段不增不减(orderIndex 不下发,顺序由数组序表达),禁字段回归测试原样生效。

## 3. 重审策略(已拍板:宽松)

打回 PENDING 的副作用 = 足迹立刻从公开面消失(他人可见唯一判据 `PUBLIC + APPROVED`),直到管理员重新批准。

| 操作 | 公开态足迹 | 依据 |
|------|-----------|------|
| 补图 | 重审(现状已实现,photos.ts 上传事务) | 引入未审内容 |
| 改文本/日期 | 重审(现状已实现,PATCH 内容分支) | 引入未审内容 |
| 删图 | **不重审**(本次决策) | 剩余每张都审过,不暴露未审内容;"掉出公开地图"对用户是重惩罚 |
| 排序 | **不重审**(本次决策) | 集合未变仅展示序;管理员随时可下架兜底 |

## 4. iOS 编辑器(FootprintEditor)

新增"照片"Section:缩略图宫格——已有照片走 `AuthedPhotoView`,staged 新照片显示本地缩略图 + 待上传角标;末尾"+"格弹 `PhotosPicker`(`.ordered`;maxSelectionCount = 9 − 宫格当前张数,"当前张数"按 staged 增删后的实际数计;满 9 隐藏"+")。选图控件从 `FootprintComposer` 抽出为共用组件(顺带还掉与 Composer 的耦合债)。

交互:
- 删除:Catalyst 悬停缩略图显 ✕(对齐 Mac 原生惯例),触屏长按菜单"删除";staged 即时从宫格消失。
- 排序:`.draggable` / `.dropDestination`(iOS 17+)拖拽重排,staged 新照片同样参与;右键/长按菜单另送"设为封面"(= 挪到第一位,拖拽的快捷方式)。

保存链路(事务式,沿用编辑器 Diff 心智,取消 = 全弃;只执行有变化的步骤,按序):
① 文本/日期/可见性 PATCH(现有逻辑与差量判断不动);
② staged 删除逐张 `DELETE /photos/:id`(② 必须先于 ③:"删旧补新"在满 9 张时要靠先删才能通过服务端上限校验);
③ staged 新增逐张 `FootprintStore.uploadPhoto(sanitized: false)`——与 Composer 完全一致:UIImage 重编码剥 EXIF,不传 takenAt/坐标;`uploadPhoto` 需把响应中的 photo id 透出(现丢弃返回体,小改);
④ 最终顺序 ≠ 服务器侧顺序(现存序 + 新增追加)时才 `PUT order`,staged 新照片用 ③ 返回的 id 填入排列。
完成后刷新 store,详情页(读 store)自动更新。

失败处理:哪步失败停哪步——弹错、编辑器保持打开、剩余 staged 不丢、可重试;不做回滚(与 Composer 现有"上传中断留部分结果"的容错水平一致)。

重审提示:`needsReReviewWarning` 扩展为"已发布 +(文本/日期变更 或 有 staged 新增)+ 未转私密"→ 保存前弹"将重新审核";纯删图/排序不弹(与 §3 一致)。

## 5. 边界

- 删到 0 张:允许——纯文字足迹本来就合法(Composer 里照片即可选项);整条不要走现有"删除足迹"。
- 上限 9:客户端由"+"格控制入口,服务端 400 兜底。
- 公开侧顺序翻转:迁移后一次性变化,自用阶段可接受,不做兼容开关。

## 6. 测试

api(vitest,真库):
- DELETE:属主错误码;DB 行删除;`storage.remove` 被调;公开态 reviewStatus 保持 APPROVED(宽松);删到 0 合法。
- order PUT:合法排列生效且幂等;集合不等 400(缺张/多张/掺入他人照片);公开态不重审。
- 上传:orderIndex 逐张递增;第 10 张 400;公开态回审既有测试保持绿。
- 公开/私密顺序一致性回归;公开 DTO 禁字段回归照旧。

迁移:`prisma migrate dev` 生成加列 + 手写回填 SQL(row_number 窗口);测试库 `push:test` 重建(加列非新表,helpers TRUNCATE 列表无需改动)。

iOS:`scripts/ios-test.sh`(模拟器 Busy 瞬态失败属环境抖动,重跑即过);编辑器 staged 差量逻辑若可单测则补。

## 7. 决策记录

- **无封面字段**:封面 = orderIndex 第一张;"设为封面"只是排序快捷方式,避免双机制。
- **回填按 id asc**:保私密侧现状;takenAt 不可用作回填键(手动撰写路径的照片 takenAt = null)。
- **先 DB 后 S3**:孤儿对象可容忍(将来可离线清理),悬空行不可。
- **排序端点收全量排列**:校验简单、天然幂等,免去"移动单张"语义的边界讨论。
- **不做保存回滚**:多操作天然非原子;编辑器保留现场可重试已足够,容错水平与 Composer 对齐。
- **宽松重审**(§3):不引入未审内容的操作不重审,避免"调个顺序就掉出公开地图"。
- **上限放宽 12**(2026-07-18 走查追记):用户拍板将单条足迹照片上限由 9 放宽至 12;双端各提取命名常量(api photos.ts `FOOTPRINT_PHOTO_LIMIT` / iOS `ZXLimit.footprintPhotos`),测试以字面量 12/13 钉住产品值;TripShareScreen 分享九宫格的 9 为独立渲染/内存约束,不随动。正文各处"9"以本条为准。
