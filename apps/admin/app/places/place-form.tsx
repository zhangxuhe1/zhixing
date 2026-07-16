"use client";
import { useState } from "react";
import { api } from "@/lib/api";
import { AMapPicker } from "./amap-picker";

export type PlaceRow = {
  id: string; name: string; level: string; parentId: string | null;
  lat: number; lng: number; intro?: string | null;
};

const LEVELS = ["PROVINCE", "CITY", "DISTRICT", "POI"] as const;
export const LEVEL_LABELS: Record<string, string> = {
  PROVINCE: "省", CITY: "市", DISTRICT: "区县", POI: "点位",
};

export function PlaceForm({ mode, initial, places, onDone, onCancel }: {
  mode: "create" | "edit";
  initial?: PlaceRow;
  places: PlaceRow[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [level, setLevel] = useState(initial?.level ?? "POI");
  const [parentId, setParentId] = useState(initial?.parentId ?? "");
  const [lat, setLat] = useState(initial ? String(initial.lat) : "");
  const [lng, setLng] = useState(initial ? String(initial.lng) : "");
  const [intro, setIntro] = useState(initial?.intro ?? "");
  const [parentFilter, setParentFilter] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // 父级候选:排除 POI(叶子不能当父)与自身,按名称过滤;已选中项恒保留,否则 select
  // 显示会与实际提交值脱节。选自身后代由服务端 cyclic_parent 兜底。
  const parentOptions = places.filter(
    (p) =>
      p.level !== "POI" && p.id !== initial?.id &&
      (p.id === parentId || parentFilter.trim() === "" || p.name.includes(parentFilter.trim())),
  );
  const valid =
    name.trim() !== "" && lat !== "" && lng !== "" &&
    Number.isFinite(Number(lat)) && Number.isFinite(Number(lng));

  async function save() {
    setSaving(true); setError("");
    try {
      if (mode === "create") {
        // POST 的 intro 是 optional 非 nullable:空值必须省略字段而非传 null
        await api("/admin/places", {
          method: "POST",
          body: JSON.stringify({
            name: name.trim(), level, parentId: parentId || null,
            lat: Number(lat), lng: Number(lng),
            intro: intro.trim() === "" ? undefined : intro.trim(),
          }),
        });
      } else {
        await api(`/admin/places/${initial!.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            name: name.trim(), level, parentId: parentId || null,
            lat: Number(lat), lng: Number(lng),
            intro: intro.trim() === "" ? null : intro.trim(),
          }),
        });
      }
      onDone();
    } catch (e) {
      const msg = String(e);
      if (msg.includes("duplicate_name")) setError("同一父级下已有同名地点");
      else if (msg.includes("cyclic_parent")) setError("父级不能选自己或自己的后代");
      else if (msg.includes("unknown_parent")) setError("父级地点不存在，刷新后重试");
      else setError(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <fieldset style={{ margin: "12px 0", padding: 12 }}>
      <legend>{mode === "create" ? "新建地点" : `编辑：${initial?.name}`}</legend>
      {error && <p style={{ color: "red" }}>{error}</p>}
      <p>
        <input placeholder="名称" value={name} onChange={(e) => setName(e.target.value)} />{" "}
        <select value={level} onChange={(e) => setLevel(e.target.value)}>
          {LEVELS.map((l) => <option key={l} value={l}>{LEVEL_LABELS[l]}</option>)}
        </select>{" "}
        <input placeholder="过滤父级…" value={parentFilter}
          onChange={(e) => setParentFilter(e.target.value)} style={{ width: 96 }} />{" "}
        <select value={parentId} onChange={(e) => setParentId(e.target.value)}>
          <option value="">（无父级 / 链顶）</option>
          {parentOptions.map((p) => (
            <option key={p.id} value={p.id}>{p.name}（{LEVEL_LABELS[p.level] ?? p.level}）</option>
          ))}
        </select>
      </p>
      <AMapPicker
        lat={lat === "" || !Number.isFinite(Number(lat)) ? null : Number(lat)}
        lng={lng === "" || !Number.isFinite(Number(lng)) ? null : Number(lng)}
        onPick={(la, ln) => { setLat(la.toFixed(6)); setLng(ln.toFixed(6)); }}
      />
      <p>
        <input placeholder="纬度 lat（GCJ-02）" value={lat}
          onChange={(e) => setLat(e.target.value)} style={{ width: 160 }} />{" "}
        <input placeholder="经度 lng（GCJ-02）" value={lng}
          onChange={(e) => setLng(e.target.value)} style={{ width: 160 }} />
      </p>
      <p>
        <textarea placeholder="简介（可空）" value={intro}
          onChange={(e) => setIntro(e.target.value)} rows={2} cols={48} />
      </p>
      <p>
        <button onClick={save} disabled={!valid || saving}>
          {saving ? "保存中…" : "保存"}
        </button>{" "}
        <button onClick={onCancel} disabled={saving}>取消</button>
      </p>
    </fieldset>
  );
}
