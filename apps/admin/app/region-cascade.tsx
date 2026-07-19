"use client";
import { useEffect, useMemo } from "react";

export type RegionPlace = { id: string; name: string; level: string; parentId: string | null };

export const LEVEL_LABELS: Record<string, string> = {
  PROVINCE: "省", CITY: "市", DISTRICT: "区县", POI: "点位",
};

/** 沿父链上溯判归属（含根自身；树深≤4）；32 跳保险丝防御脏数据成环 */
export function inSubtree(
  parentById: Map<string, string | null>,
  rootId: string,
  id: string,
): boolean {
  let cur: string | null | undefined = id;
  for (let hops = 0; cur != null && hops < 32; hops++) {
    if (cur === rootId) return true;
    cur = parentById.get(cur);
  }
  return false;
}

/** 省市两级级联下拉。省变更自动清市；已选项不再出现在数据源里时自动复位（走 onChange）。 */
export function RegionCascade({ places, provinceId, cityId, onChange, disabled }: {
  places: RegionPlace[];
  provinceId: string;
  cityId: string;
  onChange: (provinceId: string, cityId: string) => void;
  disabled?: boolean;
}) {
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

  // 数据源刷新后已选省市可能不再出现在下拉里,而 React 会把下拉重同步到首项显示、
  // 过滤却仍卡在旧根——对照下拉数据源校验,失效即复位
  useEffect(() => {
    if (provinceId && !provinces.some((p) => p.id === provinceId)) {
      onChange("", "");
    } else if (cityId && !cities.some((c) => c.id === cityId)) {
      onChange(provinceId, "");
    }
  }, [provinces, cities, provinceId, cityId, onChange]);

  return (
    <>
      <select value={provinceId} disabled={disabled}
        onChange={(e) => onChange(e.target.value, "")}>
        <option value="">全部省份</option>
        {provinces.map((p) => (
          <option key={p.id} value={p.id}>
            {p.level === "PROVINCE" ? p.name : `${p.name}（${LEVEL_LABELS[p.level] ?? p.level}）`}
          </option>
        ))}
      </select>{" "}
      <select value={cityId} onChange={(e) => onChange(provinceId, e.target.value)}
        disabled={disabled || provinceId === "" || cities.length === 0}>
        <option value="">全部市</option>
        {cities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    </>
  );
}
