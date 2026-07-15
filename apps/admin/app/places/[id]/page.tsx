"use client";
import { use, useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

type PlaceLink = { id: string; platform: string; title: string; url: string; sortOrder: number };
type PlaceDetail = { id: string; name: string; level: string; ancestors: { name: string }[]; links: PlaceLink[] };

const PLATFORMS = ["XIAOHONGSHU", "BILIBILI", "DOUYIN", "WEIBO", "OTHER"] as const;
const PLATFORM_LABELS: Record<string, string> = {
  XIAOHONGSHU: "小红书", BILIBILI: "B 站", DOUYIN: "抖音", WEIBO: "微博", OTHER: "其他",
};

export default function PlaceLinksPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [place, setPlace] = useState<PlaceDetail | null>(null);
  const [error, setError] = useState("");
  const [platform, setPlatform] = useState<string>("XIAOHONGSHU");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [sortOrder, setSortOrder] = useState(0);

  const load = useCallback(() => {
    api<PlaceDetail>(`/places/${id}`).then(setPlace).catch((e) => setError(String(e)));
  }, [id]);
  useEffect(load, [load]);

  async function addLink() {
    try {
      await api(`/admin/places/${id}/links`, {
        method: "POST",
        body: JSON.stringify({ platform, title, url, sortOrder }),
      });
      setTitle(""); setUrl(""); setSortOrder(0);
      load();
    } catch (e) { setError(String(e)); }
  }

  async function removeLink(linkId: string) {
    try {
      await api(`/admin/links/${linkId}`, { method: "DELETE" });
      load();
    } catch (e) { setError(String(e)); }
  }

  async function saveOrder(linkId: string, next: number) {
    try {
      await api(`/admin/links/${linkId}`, { method: "PATCH", body: JSON.stringify({ sortOrder: next }) });
      load();
    } catch (e) { setError(String(e)); }
  }

  if (!place) return <p>{error || "加载中…"}</p>;
  return (
    <>
      <h2>
        {place.ancestors.map((a) => a.name).concat(place.name).join(" · ")}｜网友攻略外链（{place.links.length}）
      </h2>
      {error && <p style={{ color: "red" }}>{error}</p>}
      <table>
        <thead><tr><th>排序</th><th>平台</th><th>标题</th><th>链接</th><th>操作</th></tr></thead>
        <tbody>
          {place.links.map((l) => (
            <tr key={l.id}>
              <td>
                <input
                  type="number" defaultValue={l.sortOrder} style={{ width: 64 }}
                  onBlur={(e) => {
                    const next = Number(e.target.value);
                    if (next !== l.sortOrder) saveOrder(l.id, next);
                  }}
                />
              </td>
              <td>{PLATFORM_LABELS[l.platform] ?? l.platform}</td>
              <td>{l.title}</td>
              <td><a href={l.url} target="_blank" rel="noreferrer">{l.url}</a></td>
              <td><button onClick={() => removeLink(l.id)}>删除</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>新增外链</h3>
      <p>
        <select value={platform} onChange={(e) => setPlatform(e.target.value)}>
          {PLATFORMS.map((p) => <option key={p} value={p}>{PLATFORM_LABELS[p]}</option>)}
        </select>{" "}
        <input placeholder="标题" value={title} onChange={(e) => setTitle(e.target.value)} />{" "}
        <input placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} size={40} />{" "}
        <input type="number" value={sortOrder} onChange={(e) => setSortOrder(Number(e.target.value))} style={{ width: 64 }} />{" "}
        <button onClick={addLink} disabled={!title || !url.startsWith("https://")}>添加</button>
      </p>
    </>
  );
}
