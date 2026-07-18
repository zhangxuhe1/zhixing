# 地点库省市级联筛选 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 地点库页面加省→市级联筛选与名称关键字搜索,表格显示所选子树 ∩ 层级 ∩ 关键字。

**Architecture:** 纯前端:`places/page.tsx` 内建 childrenByParent 索引,BFS 收集最深已选节点子树(含自身、防环),与现有层级筛选、新增关键字过滤 AND 组合。零 API 改动。

**Tech Stack:** Next.js 15 client component,无新依赖。

## Global Constraints

- 注释、commit message 中文;conventional commits。
- 分支 `feat/admin-places-cascade-filter`(自 main,与自动挂链支独立)。
- admin 无测试基建:`pnpm -C apps/admin exec next build` + 人工走查即验证。

---

### Task 1: places/page.tsx 级联筛选

**Files:**
- Modify: `apps/admin/app/places/page.tsx`

**Interfaces:**
- Consumes: 既有 `PlaceRow`(id/name/level/parentId/lat/lng)、`LEVEL_LABELS`。
- Produces: 页面内部状态 `provinceId` / `cityId` / `keyword`,无对外接口。

- [x] **Step 1: 实现**

状态区加三个 state;`nameById` 之后加索引、下拉数据源与子树集合;`shown` 换成组合过滤:

```tsx
  const [provinceId, setProvinceId] = useState("");
  const [cityId, setCityId] = useState("");
  const [keyword, setKeyword] = useState("");
```

```tsx
  const childrenByParent = useMemo(() => {
    const m = new Map<string, PlaceRow[]>();
    for (const p of places) {
      if (!p.parentId) continue;
      const list = m.get(p.parentId);
      if (list) list.push(p);
      else m.set(p.parentId, [p]);
    }
    return m;
  }, [places]);

  const provinces = useMemo(
    () =>
      places
        .filter((p) => p.level === "PROVINCE")
        .sort((a, b) => a.name.localeCompare(b.name, "zh")),
    [places],
  );
  const cities = useMemo(
    () =>
      provinceId
        ? (childrenByParent.get(provinceId) ?? [])
            .filter((p) => p.level === "CITY")
            .sort((a, b) => a.name.localeCompare(b.name, "zh"))
        : [],
    [childrenByParent, provinceId],
  );

  // 最深已选节点的整棵子树(含自身,便于顺手编辑省市行);Set 去重兼防脏数据成环
  const subtreeIds = useMemo(() => {
    const rootId = cityId || provinceId;
    if (!rootId) return null;
    const ids = new Set<string>([rootId]);
    const queue = [rootId];
    while (queue.length > 0) {
      const cur = queue.pop()!;
      for (const child of childrenByParent.get(cur) ?? []) {
        if (ids.has(child.id)) continue;
        ids.add(child.id);
        queue.push(child.id);
      }
    }
    return ids;
  }, [childrenByParent, cityId, provinceId]);

  const kw = keyword.trim();
  const shown = places.filter(
    (p) =>
      (subtreeIds === null || subtreeIds.has(p.id)) &&
      (levelFilter === "" || p.level === levelFilter) &&
      (kw === "" || p.name.includes(kw)),
  );
```

筛选栏(替换现有 `<p>` 中的层级 select 一段,保留新建按钮):

```tsx
      <p>
        <select value={provinceId}
          onChange={(e) => { setProvinceId(e.target.value); setCityId(""); }}>
          <option value="">全部省份</option>
          {provinces.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>{" "}
        <select value={cityId} onChange={(e) => setCityId(e.target.value)}
          disabled={provinceId === ""}>
          <option value="">全部市</option>
          {cities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>{" "}
        <select value={levelFilter} onChange={(e) => setLevelFilter(e.target.value)}>
          <option value="">全部层级</option>
          {LEVELS.map((l) => <option key={l} value={l}>{LEVEL_LABELS[l]}</option>)}
        </select>{" "}
        <input placeholder="按名称搜索…" value={keyword}
          onChange={(e) => setKeyword(e.target.value)} />{" "}
        <button onClick={() => setEditing("create")} disabled={editing !== null}>新建地点</button>
      </p>
```

- [x] **Step 2: 构建验证**

Run: `pnpm -C apps/admin exec next build`
Expected: 编译通过。

- [x] **Step 3: 人工走查**

选省→选市子树正确;直辖市(北京市)选中即见其下点位;关键字与层级叠加;换省自动清市。(2026-07-18 用户走查通过)

- [x] **Step 4: Commit**

```bash
git add apps/admin/app/places/page.tsx docs/superpowers/specs/2026-07-18-admin-places-cascade-filter-design.md docs/superpowers/plans/2026-07-18-admin-places-cascade-filter.md
git commit -m "feat(admin): 地点库省市级联筛选+名称搜索——纯前端子树过滤"
```
