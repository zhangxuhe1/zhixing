"use client";
import Link from "next/link";
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { inSubtree, LEVEL_LABELS, RegionCascade } from "../region-cascade";
import { PlaceForm, type PlaceRow } from "./place-form";

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
  const parentById = useMemo(() => new Map(places.map((p) => [p.id, p.parentId])), [places]);
  const rootId = cityId || provinceId;

  const onRegion = useCallback((p: string, c: string) => {
    setProvinceId(p);
    setCityId(c);
  }, []);

  // 关键字经 useDeferredValue 降优先级:逐键输入时表格重渲不阻塞输入;比对大小写不敏感
  const kw = useDeferredValue(keyword).trim().toLowerCase();
  const shown = places.filter(
    (p) =>
      (rootId === "" || inSubtree(parentById, rootId, p.id)) &&
      (levelFilter === "" || p.level === levelFilter) &&
      (kw === "" || p.name.toLowerCase().includes(kw)),
  );

  return (
    <>
      <h2>地点库（{shown.length}）</h2>
      {error && <p style={{ color: "red" }}>{error}</p>}
      {/* 表单打开期间筛选整体禁用(与新建按钮同规):避免行在编辑中途被筛掉造成"消失"错觉 */}
      <p>
        <RegionCascade places={places} provinceId={provinceId} cityId={cityId}
          onChange={onRegion} disabled={editing !== null} />{" "}
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
