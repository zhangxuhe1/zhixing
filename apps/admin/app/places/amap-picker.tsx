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
      s.src = `https://webapi.amap.com/maps?v=2.0&key=${KEY}&plugin=AMap.PlaceSearch`;
      s.onload = () => resolve(window.AMap);
      s.onerror = () => reject(new Error("高德地图脚本加载失败"));
      document.head.appendChild(s);
    });
  }
  return loader;
}

type Poi = { name: string; address: string; lat: number; lng: number };

export function AMapPicker({ lat, lng, onPick }: {
  lat: number | null;
  lng: number | null;
  onPick: (lat: number, lng: number) => void;
}) {
  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markerRef = useRef<any>(null);
  const onPickRef = useRef(onPick);
  onPickRef.current = onPick;
  const [keyword, setKeyword] = useState("");
  const [results, setResults] = useState<Poi[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!KEY || !mapEl.current) return;
    let disposed = false;
    loadAMap()
      .then((AMap) => {
        if (disposed || !mapEl.current) return;
        const hasInit = lat !== null && lng !== null;
        const map = new AMap.Map(mapEl.current, {
          zoom: hasInit ? 15 : 4,
          center: hasInit ? [lng, lat] : [105, 36],
        });
        mapRef.current = map;
        if (hasInit) placeMarker(lng!, lat!);
        map.on("click", (e: any) => {
          placeMarker(e.lnglat.getLng(), e.lnglat.getLat());
          onPickRef.current(e.lnglat.getLat(), e.lnglat.getLng());
        });
      })
      .catch((e) => setError(String(e)));
    return () => {
      disposed = true;
      mapRef.current?.destroy();
      mapRef.current = null;
    };
    // 仅初始化一次:lat/lng 后续变化经 placeMarker 驱动,不重建地图
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function placeMarker(lngV: number, latV: number) {
    const map = mapRef.current;
    if (!map || !window.AMap) return;
    if (!markerRef.current) {
      // 可拖拽:拖 pin 微调坐标(spec"点击/拖 pin"),dragend 回填
      const marker = new window.AMap.Marker({ position: [lngV, latV], draggable: true });
      marker.on("dragend", () => {
        const pos = marker.getPosition();
        onPickRef.current(pos.getLat(), pos.getLng());
      });
      markerRef.current = marker;
      map.add(marker);
    } else {
      markerRef.current.setPosition([lngV, latV]);
    }
  }

  function search() {
    if (!window.AMap || !keyword.trim()) return;
    new window.AMap.PlaceSearch({ pageSize: 5 }).search(
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
          })),
        );
      },
    );
  }

  function pickPoi(p: Poi) {
    mapRef.current?.setZoomAndCenter(16, [p.lng, p.lat]);
    placeMarker(p.lng, p.lat);
    onPickRef.current(p.lat, p.lng);
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
