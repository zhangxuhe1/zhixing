"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { inSubtree, LEVEL_LABELS, RegionCascade, type RegionPlace } from "../region-cascade";

type CardRow = {
  id: string; title: string; category: string; status: string;
  createdAt: string; placeId: string; placeName: string;
};

const CATEGORY_ZH: Record<string, string> = {
  CUSTOMS: "习俗", FOOD: "吃食", DIALECT: "方言", ANECDOTE: "掌故", PLACE_NAME: "地名由来",
};
const STATUS_ZH: Record<string, string> = {
  AI_GENERATED: "AI 生成待复核", REVIEWED: "已复核", RETIRED: "已下架",
};
const PAGE_SIZE = 50;

// 请求参数收拢为单个 state:任何筛选变化与 page: 1 同一次更新落地,
// 避免"先按旧页码请求、再重置页码二次请求"的浪费与闪烁
type Filters = {
  provinceId: string; cityId: string; placeId: string;
  category: string; status: string; q: string; page: number;
};
const INITIAL: Filters = {
  provinceId: "", cityId: "", placeId: "", category: "", status: "", q: "", page: 1,
};

export default function CardsPage() {
  const [places, setPlaces] = useState<RegionPlace[]>([]);
  const [keyword, setKeyword] = useState(""); // 输入框即时值;filters.q 是防抖落定值
  const [filters, setFilters] = useState<Filters>(INITIAL);
  const [data, setData] = useState<{ total: number; items: CardRow[] }>({ total: 0, items: [] });
  const [error, setError] = useState("");

  useEffect(() => {
    api<RegionPlace[]>("/places").then(setPlaces).catch((e) => setError(String(e)));
  }, []);

  // 关键字 300ms 防抖:落定后并入 filters 并重置回第 1 页(与其它筛选同规)
  useEffect(() => {
    const t = setTimeout(() => {
      setFilters((f) => (f.q === keyword ? f : { ...f, q: keyword, page: 1 }));
    }, 300);
    return () => clearTimeout(t);
  }, [keyword]);

  useEffect(() => {
    const under = filters.placeId || filters.cityId || filters.provinceId;
    const params = new URLSearchParams();
    if (under) params.set("under", under);
    if (filters.category) params.set("category", filters.category);
    if (filters.status) params.set("status", filters.status);
    if (filters.q.trim() !== "") params.set("q", filters.q.trim());
    params.set("page", String(filters.page));
    params.set("pageSize", String(PAGE_SIZE));
    api<{ total: number; items: CardRow[] }>(`/admin/cards?${params}`)
      .then((d) => { setData(d); setError(""); })
      .catch((e) => setError(String(e)));
  }, [filters]);

  const parentById = useMemo(() => new Map(places.map((p) => [p.id, p.parentId])), [places]);
  const rootId = filters.cityId || filters.provinceId;
  // 地点下拉:当前省/市子树内的区县与点位(不含根自身),中文排序、带层级标注
  const spotOptions = useMemo(
    () =>
      rootId === ""
        ? []
        : places
            .filter(
              (p) =>
                p.id !== rootId &&
                (p.level === "DISTRICT" || p.level === "POI") &&
                inSubtree(parentById, rootId, p.id),
            )
            .sort((a, b) => a.name.localeCompare(b.name, "zh")),
    [places, parentById, rootId],
  );

  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));

  return (
    <>
      <h2>风物卡（{data.total}）</h2>
      {error && <p style={{ color: "red" }}>{error}</p>}
      <p>
        <RegionCascade places={places} provinceId={filters.provinceId} cityId={filters.cityId}
          onChange={(provinceId, cityId) =>
            setFilters((f) => ({ ...f, provinceId, cityId, placeId: "", page: 1 }))} />{" "}
        <select value={filters.placeId} disabled={rootId === ""}
          onChange={(e) => setFilters((f) => ({ ...f, placeId: e.target.value, page: 1 }))}>
          <option value="">全部地点</option>
          {spotOptions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}（{LEVEL_LABELS[p.level] ?? p.level}）
            </option>
          ))}
        </select>{" "}
        <select value={filters.category}
          onChange={(e) => setFilters((f) => ({ ...f, category: e.target.value, page: 1 }))}>
          <option value="">全部分类</option>
          {Object.entries(CATEGORY_ZH).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>{" "}
        <select value={filters.status}
          onChange={(e) => setFilters((f) => ({ ...f, status: e.target.value, page: 1 }))}>
          <option value="">全部状态</option>
          {Object.entries(STATUS_ZH).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>{" "}
        <input placeholder="按标题搜索…" value={keyword}
          onChange={(e) => setKeyword(e.target.value)} />
      </p>
      <table>
        <thead>
          <tr><th>标题</th><th>地点</th><th>分类</th><th>状态</th><th>创建时间</th></tr>
        </thead>
        <tbody>
          {data.items.map((c) => (
            <tr key={c.id}>
              <td><Link href={`/cards/${c.id}`}>{c.title}</Link></td>
              <td>{c.placeName}</td>
              <td>{CATEGORY_ZH[c.category] ?? c.category}</td>
              <td><span className={`badge ${c.status}`}>{STATUS_ZH[c.status] ?? c.status}</span></td>
              <td>{new Date(c.createdAt).toLocaleDateString("zh-CN")}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        <button disabled={filters.page <= 1}
          onClick={() => setFilters((f) => ({ ...f, page: f.page - 1 }))}>上一页</button>{" "}
        第 {filters.page} / {totalPages} 页（共 {data.total} 条）{" "}
        <button disabled={filters.page >= totalPages}
          onClick={() => setFilters((f) => ({ ...f, page: f.page + 1 }))}>下一页</button>
      </p>
    </>
  );
}
