"use client";
import { useEffect, useRef, useState } from "react";

// 高德 JS API 无官方 TS 类型,按 any 使用;坐标序注意是 [lng, lat]
declare global {
  interface Window {
    AMap?: any;
    _AMapSecurityConfig?: { securityJsCode: string };
  }
}

const KEY = process.env.NEXT_PUBLIC_AMAP_KEY;
const SECURITY = process.env.NEXT_PUBLIC_AMAP_SECURITY_CODE;

let loader: Promise<any> | null = null;
function loadAMap(): Promise<any> {
  if (window.AMap) return Promise.resolve(window.AMap);
  if (!loader) {
    loader = new Promise((resolve, reject) => {
      // 安全密钥必须在脚本加载前挂到 window,否则 PlaceSearch 等服务报 INVALID_USER_SCODE
      if (SECURITY) window._AMapSecurityConfig = { securityJsCode: SECURITY };
      const s = document.createElement("script");
      s.src = `https://webapi.amap.com/maps?v=2.0&key=${KEY}&plugin=AMap.PlaceSearch,AMap.Geocoder,AMap.DistrictSearch`;
      s.onload = () => resolve(window.AMap);
      s.onerror = () => reject(new Error("高德地图脚本加载失败"));
      document.head.appendChild(s);
    });
  }
  return loader;
}

type Poi = { name: string; address: string; lat: number; lng: number; region: AdminRegion | null };

export type ZXCenter = { lat: number; lng: number };

/** cityName 为 null:直辖市/特区(市名=省名)或省直辖(市名为空),链上只有省级节点。
 *  center 是行政中心坐标(DistrictSearch 异步补齐):服务端创建新省市必须带坐标——
 *  否则新市会落在点位坐标上,毒化 iOS 照片匹配的距离/半径打分 */
export type AdminRegion = {
  provinceName: string;
  cityName: string | null;
  provinceCenter?: ZXCenter;
  cityCenter?: ZXCenter;
};

// 高德空字段可能是 "" 或 [],统一收敛成 trim 后字符串
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function toRegion(provinceRaw: unknown, cityRaw: unknown): AdminRegion | null {
  const province = str(provinceRaw);
  if (!province) return null;
  const city = str(cityRaw);
  return { provinceName: province, cityName: city && city !== province ? city : null };
}

// 行政区名 → 行政中心坐标(GCJ-02);查不到返回 null,由服务端拦截无坐标创建兜底
function districtCenter(name: string, level: "province" | "city"): Promise<ZXCenter | null> {
  return new Promise((resolve) => {
    new window.AMap.DistrictSearch({ level, subdistrict: 0, extensions: "base" }).search(
      name,
      (status: string, result: any) => {
        const c = result?.districtList?.[0]?.center;
        const lat = typeof c?.getLat === "function" ? c.getLat() : c?.lat;
        const lng = typeof c?.getLng === "function" ? c.getLng() : c?.lng;
        resolve(
          status === "complete" && Number.isFinite(lat) && Number.isFinite(lng)
            ? { lat, lng }
            : null,
        );
      },
    );
  });
}

export function AMapPicker({ lat, lng, onPick, onRegion }: {
  lat: number | null;
  lng: number | null;
  onPick: (lat: number, lng: number) => void;
  onRegion?: (region: AdminRegion | null) => void;
}) {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markerRef = useRef<any>(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const onRegionRef = useRef(onRegion);
  onRegionRef.current = onRegion;
  // 区域解析序号:每次同步回传或坐标接管自增,在途异步结果按序号丢弃——
  // 防止乱序/迟到的逆编码把 region 打回旧位置(坐标已换、省市却是上一处的)
  const regionSeqRef = useRef(0);
  // 地图脚本异步加载完成时取"最新"坐标放初始 pin,而非挂载瞬间捕获的旧值
  const posRef = useRef({ lat, lng });
  posRef.current = { lat, lng };
  const [keyword, setKeyword] = useState("");
  const [results, setResults] = useState<Poi[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!KEY || !mapEl.current) return;
    let disposed = false;
    loadAMap()
      .then((AMap) => {
        if (disposed || !mapEl.current) return;
        const { lat: la, lng: ln } = posRef.current;
        const hasInit = la !== null && ln !== null;
        const map = new AMap.Map(mapEl.current, {
          zoom: hasInit ? 15 : 4,
          center: hasInit ? [ln, la] : [105, 36],
        });
        mapRef.current = map;
        if (hasInit) placeMarker(ln!, la!);
        map.on("click", (e: any) => {
          placeMarker(e.lnglat.getLng(), e.lnglat.getLat());
          onPickRef.current(e.lnglat.getLat(), e.lnglat.getLng());
          resolveRegion(e.lnglat.getLng(), e.lnglat.getLat());
        });
      })
      .catch((e) => setError(String(e)));
    return () => {
      disposed = true;
      mapRef.current?.destroy();
      mapRef.current = null;
    };
    // 仅初始化一次,不重建地图;后续 lat/lng 变化由下方跟随 effect 同步 pin
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 表单手输坐标 → 地图跟随核对。600ms 防抖:逐字输入的中间值(如"3"→"39")不惊动地图;
  // 与 marker 现位置几乎重合(±1e-5°≈1m,地图侧点击/拖拽经 toFixed(6) 回流是这种情形)
  // 则跳过,避免点完地图又被拉回居中。
  useEffect(() => {
    if (lat === null || lng === null) return;
    const t = setTimeout(() => {
      if (!mapRef.current) return;
      const cur = markerRef.current?.getPosition();
      if (cur && Math.abs(cur.getLat() - lat) < 1e-5 && Math.abs(cur.getLng() - lng) < 1e-5) {
        return;
      }
      // 手输坐标接管:作废在途的区域解析,避免旧位置的逆编码结果迟到复活
      regionSeqRef.current++;
      placeMarker(lng, lat);
      mapRef.current.setZoomAndCenter(16, [lng, lat]);
    }, 600);
    return () => clearTimeout(t);
  }, [lat, lng]);

  function placeMarker(lngV: number, latV: number) {
    const map = mapRef.current;
    if (!map || !window.AMap) return;
    if (!markerRef.current) {
      // 可拖拽:拖 pin 微调坐标(spec"点击/拖 pin"),dragend 回填
      const marker = new window.AMap.Marker({ position: [lngV, latV], draggable: true });
      marker.on("dragend", () => {
        const pos = marker.getPosition();
        onPickRef.current(pos.getLat(), pos.getLng());
        resolveRegion(pos.getLng(), pos.getLat());
      });
      markerRef.current = marker;
      map.add(marker);
    } else {
      markerRef.current.setPosition([lngV, latV]);
    }
  }

  // 同步回传 region,并异步补齐省市行政中心(同一序号内二次回传富化结果)
  function emitRegion(region: AdminRegion | null) {
    const seq = ++regionSeqRef.current;
    onRegionRef.current?.(region);
    if (!region || !window.AMap?.DistrictSearch) return;
    const provP = districtCenter(region.provinceName, "province");
    const cityP = region.cityName
      ? districtCenter(region.cityName, "city")
      : Promise.resolve(null);
    Promise.all([provP, cityP]).then(([prov, city]) => {
      if (seq !== regionSeqRef.current) return;
      onRegionRef.current?.({
        ...region,
        ...(prov ? { provinceCenter: prov } : {}),
        ...(city ? { cityCenter: city } : {}),
      });
    });
  }

  // 地图点选/拖 pin 没有 POI 语境,用逆地理编码反查省市;失败回传 null 让表单降级手选
  function resolveRegion(lngV: number, latV: number) {
    if (!onRegionRef.current) return;
    const seq = ++regionSeqRef.current;
    if (!window.AMap?.Geocoder) {
      // 旧脚本缓存等场景插件缺失:显式置空,不能让 region 静默冻结在上一次的值
      onRegionRef.current(null);
      return;
    }
    new window.AMap.Geocoder().getAddress([lngV, latV], (status: string, result: any) => {
      if (seq !== regionSeqRef.current) return;
      if (status !== "complete" || !result?.regeocode) {
        onRegionRef.current?.(null);
        return;
      }
      const comp = result.regeocode.addressComponent ?? {};
      emitRegion(toRegion(comp.province, comp.city));
    });
  }

  function search() {
    if (!window.AMap || !keyword.trim()) return;
    new window.AMap.PlaceSearch({ pageSize: 5, extensions: "all" }).search(
      keyword.trim(),
      (status: string, result: any) => {
        if (status !== "complete") {
          setResults([]);
          setError(status === "no_data" ? "没有搜到结果" : `搜索失败：${status}`);
          return;
        }
        setError("");
        setResults(
          result.poiList.pois.map((p: any) => ({
            name: p.name, address: p.address || "",
            lat: p.location.lat, lng: p.location.lng,
            region: toRegion(p.pname, p.cityname),
          })),
        );
      },
    );
  }

  function pickPoi(p: Poi) {
    mapRef.current?.setZoomAndCenter(16, [p.lng, p.lat]);
    placeMarker(p.lng, p.lat);
    onPickRef.current(p.lat, p.lng);
    emitRegion(p.region);
    setResults([]);
  }

  if (!KEY) return null; // 未配 key:表单退化为手动输入经纬度

  return (
    <div style={{ margin: "8px 0" }}>
      <p>
        <input placeholder="搜地名定位（高德）" value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); search(); } }}
          size={32} />{" "}
        <button type="button" onClick={search}>搜索</button>
        {error && <span style={{ color: "red", marginLeft: 8 }}>{error}</span>}
      </p>
      {results.length > 0 && (
        <ul style={{ margin: "4px 0", paddingLeft: 20 }}>
          {results.map((p, i) => (
            <li key={i}>
              <button type="button" onClick={() => pickPoi(p)}
                style={{ border: "none", background: "none", color: "#06c", cursor: "pointer", padding: 0 }}>
                {p.name}
              </button>{" "}
              <small>{p.address}</small>
            </li>
          ))}
        </ul>
      )}
      <div ref={mapEl} style={{ width: "100%", maxWidth: 640, height: 320, border: "1px solid #ccc" }} />
      <p><small>点击地图或选择搜索结果，坐标（GCJ-02）自动回填下方输入框。</small></p>
    </div>
  );
}
