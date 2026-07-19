"use client";
import { useRef, useState } from "react";
import { api } from "@/lib/api";
import { AMapPicker, type AdminRegion, type ZXCenter } from "./amap-picker";
import { LEVEL_LABELS } from "../region-cascade";

export type PlaceRow = {
  id: string; name: string; level: string; parentId: string | null;
  lat: number; lng: number; intro?: string | null;
};

const LEVELS = ["PROVINCE", "CITY", "DISTRICT", "POI"] as const;

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
  const [region, setRegion] = useState<AdminRegion | null>(null);
  // 显式退出位:点"不挂链"或亲手选"链顶"置真,仅"恢复自动挂链"按钮置假——
  // 不用清 region 表达退出,否则迟到的逆编码回调/拖 pin 会复活已明确拒绝的挂链
  const [chainOff, setChainOff] = useState(false);
  // 当前生效坐标的同步基准(state 是异步的,选点回调紧随 onPick 同 tick 到达):
  // 地图选点写入,手输坐标清空;onRegion 回调坐标对不上基准即视为过期丢弃
  const coordsRef = useRef<ZXCenter | null>(null);

  function acceptRegion(r: AdminRegion | null, at: ZXCenter) {
    if (r !== null) {
      const c = coordsRef.current;
      if (!c || Math.abs(c.lat - at.lat) > 1e-5 || Math.abs(c.lng - at.lng) > 1e-5) return;
    }
    setRegion(r);
  }

  // 单一构造:链数组即提交载荷,提示文案由它派生。区县/点位挂[省,市?];层级选"市"
  // 挂[省](否则建市落成链顶,与省下同名市擦肩成重复);省自身即链顶不挂。
  // 坐标来自 DistrictSearch 行政中心(异步补齐,缺失时服务端会拦创建)。
  const chain =
    mode === "create" && !chainOff && region !== null && parentId === "" &&
    (level === "POI" || level === "DISTRICT" || level === "CITY")
      ? level === "CITY" || region.cityName === null
        ? [{ name: region.provinceName, level: "PROVINCE" as const,
             ...(region.provinceCenter ?? {}) }]
        : [
            { name: region.provinceName, level: "PROVINCE" as const,
              ...(region.provinceCenter ?? {}) },
            { name: region.cityName, level: "CITY" as const,
              ...(region.cityCenter ?? {}) },
          ]
      : null;

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
        // 挂链时 ancestors 与 parentId 互斥,由服务端幂等 find-or-create/收编补挂
        await api("/admin/places", {
          method: "POST",
          body: JSON.stringify({
            name: name.trim(), level,
            ...(chain ? { ancestors: chain } : { parentId: parentId || null }),
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
      else if (msg.includes("conflicting_parent")) setError("父级与自动挂链冲突，请重试");
      else if (msg.includes("invalid_ancestors")) setError("自动挂链数据异常，请手动选择父级");
      else if (msg.includes("ancestor_coords_required"))
        setError("省市行政中心坐标获取失败，请稍候重试或手动选择父级");
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
        <select value={parentId} onChange={(e) => {
          setParentId(e.target.value);
          // 亲手选"链顶"即退出自动挂链——该 onChange 只可能由用户选择触发,
          // 否则选项承诺"链顶"、提交却发 ancestors,言行不一
          if (e.target.value === "") setChainOff(true);
        }}>
          <option value="">（无父级 / 链顶）</option>
          {parentOptions.map((p) => (
            <option key={p.id} value={p.id}>{p.name}（{LEVEL_LABELS[p.level] ?? p.level}）</option>
          ))}
        </select>
      </p>
      <AMapPicker
        lat={lat === "" || !Number.isFinite(Number(lat)) ? null : Number(lat)}
        lng={lng === "" || !Number.isFinite(Number(lng)) ? null : Number(lng)}
        onPick={(la, ln) => {
          coordsRef.current = { lat: la, lng: ln };
          setLat(la.toFixed(6)); setLng(ln.toFixed(6));
        }}
        onRegion={mode === "create" ? acceptRegion : undefined}
      />
      {chain && (
        <p style={{ color: "#087" }}>
          将自动挂入：{chain.map((a) => a.name).join(" → ")} → 本{LEVEL_LABELS[level] ?? "地点"}
          （省市不存在则自动创建；改选父级可覆盖）{" "}
          <button type="button" onClick={() => setChainOff(true)}>不挂链</button>
        </p>
      )}
      {mode === "create" && chainOff && region !== null && (
        <p><small>已关闭自动挂链{" "}
          <button type="button" onClick={() => setChainOff(false)}>恢复自动挂链</button>
        </small></p>
      )}
      <p>
        {/* 手输坐标使 region 失效并清坐标基准:坐标已是新位置、省市还是旧位置的,
            宁可清掉降级手选;基准清空后在途/迟到的区域回调全部对不上号被丢弃 */}
        <input placeholder="纬度 lat（GCJ-02）" value={lat}
          onChange={(e) => { setLat(e.target.value); setRegion(null); coordsRef.current = null; }}
          style={{ width: 160 }} />{" "}
        <input placeholder="经度 lng（GCJ-02）" value={lng}
          onChange={(e) => { setLng(e.target.value); setRegion(null); coordsRef.current = null; }}
          style={{ width: 160 }} />
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
