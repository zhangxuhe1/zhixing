"use client";
import Link from "next/link";
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { LEVEL_LABELS, PlaceForm, type PlaceRow } from "./place-form";

const LEVELS = ["PROVINCE", "CITY", "DISTRICT", "POI"] as const;

export default function PlacesPage() {
  const [places, setPlaces] = useState<PlaceRow[]>([]);
  const [error, setError] = useState("");
  const [levelFilter, setLevelFilter] = useState("");
  const [provinceId, setProvinceId] = useState("");
  const [cityId, setCityId] = useState("");
  const [keyword, setKeyword] = useState("");
  const [editing, setEditing] = useState<PlaceRow | "create" | null>(null);

  const load = useCallback(() => {
    api<PlaceRow[]>("/places")
      .then((ps) => { setPlaces(ps); setError(""); })
      .catch((e) => setError(String(e)));
  }, []);
  useEffect(load, [load]);

  const nameById = useMemo(() => new Map(places.map((p) => [p.id, p.name])), [places]);

  // 省下拉取链顶(parentId 为空)而非 level=PROVINCE——与服务端 trips/footprints 的
  // 链顶语义一致;遗留"无父级城市"这类脏数据也会出现在下拉(带层级标注),整棵子树
  // 保持可达且可当场改父修复
  const provinces = useMemo(
    () =>
      places
        .filter((p) => !p.parentId)
        .sort((a, b) => a.name.localeCompare(b.name, "zh")),
    [places],
  );
  const cities = useMemo(
    () =>
      places
        .filter((p) => p.parentId === provinceId && p.level === "CITY")
        .sort((a, b) => a.name.localeCompare(b.name, "zh")),
    [places, provinceId],
  );

  // 编辑可自由改层级/改父:刷新后已选省市可能不再出现在下拉数据源里,而 React 会把
  // 下拉重同步到首项显示、过滤却仍卡在旧根——对照下拉数据源校验,失效即复位
  useEffect(() => {
    if (provinceId && !provinces.some((p) => p.id === provinceId)) {
      setProvinceId("");
      setCityId("");
    } else if (cityId && !cities.some((c) => c.id === cityId)) {
      setCityId("");
    }
  }, [provinces, cities, provinceId, cityId]);

  const parentById = useMemo(() => new Map(places.map((p) => [p.id, p.parentId])), [places]);
  const rootId = cityId || provinceId;
  // 沿父链上溯判归属(含根自身,便于顺手编辑省市行;树深≤4);32 跳保险丝防御
  // 脏数据成环,与服务端 reachesSelf 同思路
  function inSubtree(id: string): boolean {
    let cur: string | null | undefined = id;
    for (let hops = 0; cur != null && hops < 32; hops++) {
      if (cur === rootId) return true;
      cur = parentById.get(cur);
    }
    return false;
  }

  // 关键字经 useDeferredValue 降优先级:逐键输入时表格重渲不阻塞输入;比对大小写不敏感
  const kw = useDeferredValue(keyword).trim().toLowerCase();
  const shown = places.filter(
    (p) =>
      (rootId === "" || inSubtree(p.id)) &&
      (levelFilter === "" || p.level === levelFilter) &&
      (kw === "" || p.name.toLowerCase().includes(kw)),
  );

  return (
    <>
      <h2>地点库（{shown.length}）</h2>
      {error && <p style={{ color: "red" }}>{error}</p>}
      {/* 表单打开期间筛选整体禁用(与新建按钮同规):避免行在编辑中途被筛掉造成"消失"错觉 */}
      <p>
        <select value={provinceId} disabled={editing !== null}
          onChange={(e) => { setProvinceId(e.target.value); setCityId(""); }}>
          <option value="">全部省份</option>
          {provinces.map((p) => (
            <option key={p.id} value={p.id}>
              {p.level === "PROVINCE" ? p.name : `${p.name}（${LEVEL_LABELS[p.level] ?? p.level}）`}
            </option>
          ))}
        </select>{" "}
        <select value={cityId} onChange={(e) => setCityId(e.target.value)}
          disabled={editing !== null || provinceId === "" || cities.length === 0}>
          <option value="">全部市</option>
          {cities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>{" "}
        <select value={levelFilter} disabled={editing !== null}
          onChange={(e) => setLevelFilter(e.target.value)}>
          <option value="">全部层级</option>
          {LEVELS.map((l) => <option key={l} value={l}>{LEVEL_LABELS[l]}</option>)}
        </select>{" "}
        <input placeholder="按名称搜索…" value={keyword} disabled={editing !== null}
          onChange={(e) => setKeyword(e.target.value)} />{" "}
        <button onClick={() => setEditing("create")} disabled={editing !== null}>新建地点</button>
      </p>
      {editing !== null && (
        <PlaceForm
          mode={editing === "create" ? "create" : "edit"}
          initial={editing === "create" ? undefined : editing}
          places={places}
          onDone={() => { setEditing(null); load(); }}
          onCancel={() => setEditing(null)}
        />
      )}
      <table>
        <thead>
          <tr><th>名称</th><th>层级</th><th>父级</th><th>坐标</th><th>操作</th></tr>
        </thead>
        <tbody>
          {shown.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td>{LEVEL_LABELS[p.level] ?? p.level}</td>
              <td>{p.parentId ? nameById.get(p.parentId) ?? "?" : "—"}</td>
              <td>{p.lat.toFixed(3)}, {p.lng.toFixed(3)}</td>
              <td>
                <button onClick={() => setEditing(p)} disabled={editing !== null}>编辑</button>{" "}
                <Link href={`/places/${p.id}`}>外链</Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
