"use client";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
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
    api<PlaceRow[]>("/places").then(setPlaces).catch((e) => setError(String(e)));
  }, []);
  useEffect(load, [load]);

  const nameById = useMemo(() => new Map(places.map((p) => [p.id, p.name])), [places]);

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

  return (
    <>
      <h2>地点库（{shown.length}）</h2>
      {error && <p style={{ color: "red" }}>{error}</p>}
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
