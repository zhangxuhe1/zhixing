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
  const [editing, setEditing] = useState<PlaceRow | "create" | null>(null);

  const load = useCallback(() => {
    api<PlaceRow[]>("/places").then(setPlaces).catch((e) => setError(String(e)));
  }, []);
  useEffect(load, [load]);

  const nameById = useMemo(() => new Map(places.map((p) => [p.id, p.name])), [places]);
  const shown = levelFilter ? places.filter((p) => p.level === levelFilter) : places;

  return (
    <>
      <h2>地点库（{shown.length}）</h2>
      {error && <p style={{ color: "red" }}>{error}</p>}
      <p>
        <select value={levelFilter} onChange={(e) => setLevelFilter(e.target.value)}>
          <option value="">全部层级</option>
          {LEVELS.map((l) => <option key={l} value={l}>{LEVEL_LABELS[l]}</option>)}
        </select>{" "}
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
