# 风物卡管理列表（卡片中心化）设计

## 背景与目标

管理端「风物卡」(/cards) 现状:全库地点塞进一个按创建顺序排列的平铺下拉,省/市/区/POI 混杂、无搜索,地点一多即不可用;且一次只能看单个地点的卡片,无跨地点总览、无分类/状态筛选、无标题搜索。列表还复用 App 面的 `GET /places/:id/cards`——固定滤掉 RETIRED(管理台看不到已退休卡),且每张卡附带全量 blocks(列表用不上,白传流量)。

目标:卡片页升级为真正的**卡片管理列表**——省市级联圈定子树 + 分类/状态/标题关键字筛选 + 服务端分页,随内容库增长保持可维护。

## 方案取舍

- **卡片中心化管理列表(选定)**:新增 `GET /admin/cards` 服务端筛选+分页。卡片量级将达千/万(每 POI 3-5 卡 × 全国点位),必须服务端分页;顺手解决 RETIRED 不可见与 blocks 白传两个暗坑。
- 纯前端换地点选择器:只解决"找地点难",跨地点总览/状态筛选受数据源天花板限制做不了,大概率二次改造,弃。
- 前端聚合子树多请求:请求数随子树规模爆炸,弃。

## API 设计

`GET /admin/cards`(requireAdmin),query 全部可选(zod 校验):

- `under` — 任意 placeId,**子树语义**(含自身及全部子孙的卡);不传 = 全库
- `category` — 五分类枚举之一
- `status` — AI_GENERATED / REVIEWED / RETIRED;不传 = 全部状态(RETIRED 从此管理可见)
- `q` — 标题关键字,大小写不敏感 contains(只搜标题,不搜 blocks 正文,避免 join)
- `page` 默认 1;`pageSize` 默认 50、上限 200(数字参数 z.coerce)

返回 `{ total, items }`,按 createdAt desc。item 逐字段组装 DTO:`id / title / category / status / createdAt / placeId / placeName`,**不带 blocks**。

子树计算:新建 `src/placeSubtree.ts`(与 `placeAncestors.ts` 对称)——一次 `findMany` 只取全量 `(id, parentId)`,内存建邻接表从 `under` 向下 BFS 展开子孙集合(树深 ≤4、千行量级毫秒级,visited set 防脏数据成环),然后 `placeId IN (...)`。不用递归 CTE:Prisma 不原生支持,`$queryRaw` 手写 SQL 损可测性,该规模内存展开足够。

App 面 `GET /places/:id/cards` 与 `GET /cards/:id` 一律不动,iOS 零影响。

## 前端交互

- 从 `places/page.tsx` 抽出**共享省市级联组件**(省/市两级下拉 + 失效自动复位逻辑),地点库页改用它,行为不变。
- `cards/page.tsx` 重写为管理列表:
  - 筛选行:`[省 ▾] [市 ▾] [地点 ▾] [分类 ▾] [状态 ▾] [标题关键字]`。地点下拉 = 当前子树内的 DISTRICT/POI(中文排序、带层级标注),未选省时禁用;`under` 取最深已选层(地点 > 市 > 省),全空 = 全库最新卡。直辖市"省下无市"的链:市下拉自然为空禁用,地点下拉直列区县/POI,不受影响。
  - 表格列:标题(链详情)/ 地点(placeName)/ 分类(沿用 CATEGORY_ZH)/ 状态 badge / 创建时间;h2 显示 total。
  - 分页:上一页/下一页 + 总数;**任何筛选变化重置回第 1 页**。
  - 关键字 300ms 防抖后请求(改服务端分页后,地点库那套 useDeferredValue 本地过滤不再适用)。
- 详情页已有「标记已复核 / 下架」,列表保持只读 + 链接,不加快捷状态按钮(避免误触)。

## 已知取舍

- `q` 只搜标题;搜正文需 join blocks,待有真实需求再议。
- 只选省(不选市)时地点下拉会列全省区县+POI,较长;预期用法是先选市缩小,暂不做下拉内搜索。
- 不提供"只看挂在省/市节点自身的卡"独立入口,子树视图已覆盖其可见性。

## 验证

- API 集成测试(真库,沿用 helpers):子树含省/市/区/POI 各层卡片、兄弟省不串、各筛选器单独与组合、分页 total 正确、RETIRED 可见、无 token 401、非法参数 400。
- admin 无测试基建:`next build` 类型检查 + Mac 端人工走查(省→市→地点三步定位、状态筛 AI_GENERATED 看全待复核、翻页、防抖)。
