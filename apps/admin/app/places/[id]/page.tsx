"use client";
import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";

type LinkTag = { id: string; name: string };
type PlaceLink = {
  id: string; platform: string; title: string; url: string; sortOrder: number;
  tag: LinkTag | null;
};
type PlaceLinks = {
  id: string; name: string; level: string;
  ancestors: { name: string }[]; links: PlaceLink[];
};
type TagOption = { id: string; name: string; sortOrder: number; linkCount: number };

const PLATFORMS = ["XIAOHONGSHU", "BILIBILI", "DOUYIN", "WEIBO", "OTHER"] as const;
const PLATFORM_LABELS: Record<string, string> = {
  XIAOHONGSHU: "小红书", BILIBILI: "B 站", DOUYIN: "抖音", WEIBO: "微博", OTHER: "其他",
};

// Array.prototype.sort 是稳定排序:平序保持既有相对顺序(≈ 服务端的 createdAt,id 次序)
const byOrder = (a: PlaceLink, b: PlaceLink) => a.sortOrder - b.sortOrder;

export default function PlaceLinksPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [place, setPlace] = useState<PlaceLinks | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [syncCount, setSyncCount] = useState(0); // 页面级写锁引用计数:>0 期间禁用全页写控件
  const [orderDrafts, setOrderDrafts] = useState<Record<string, string>>({}); // 排序输入受控草稿
  const [tags, setTags] = useState<TagOption[]>([]);
  const [error, setError] = useState("");
  const [platform, setPlatform] = useState<string>("XIAOHONGSHU");
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [sortOrder, setSortOrder] = useState(0);
  const [tagId, setTagId] = useState("");
  const syncing = syncCount > 0;

  // 管理端读鉴权接口:编辑需要 tagId,公开 DTO 只有标签名。双 GET 原子提交:先拿齐两份
  // 结果再一起 setState,不提交半份快照;失败向上抛,由初始 effect / reloadLocked 决定呈现
  const load = useCallback(async () => {
    const [placeDetail, tagList] = await Promise.all([
      api<PlaceLinks>(`/admin/places/${id}/links`),
      api<TagOption[]>("/admin/link-tags"),
    ]);
    setPlace(placeDetail);
    setTags(tagList);
  }, [id]);
  useEffect(() => { void load().catch((e) => setError(String(e))); }, [load]);

  const locked = (linkId: string) => syncing || busyIds.has(linkId);
  function setBusy(linkId: string, on: boolean) {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(linkId); else next.delete(linkId);
      return next;
    });
  }
  const clearOrderDraft = (linkId: string) =>
    setOrderDrafts((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== linkId)));

  // 不变量:初始加载后,整页 GET 只在写锁内发生——锁内发不出新写,陈旧快照无从覆盖别行新值。
  // 引用计数持锁:并发触发多次回拉时,最后一个结束(finally)才解锁——先完成者不得提前放行
  // 新写,否则仍在途的旧 GET 可能覆盖锁外新写;回拉失败设置 error 后解锁,页面停留在旧快照。
  async function reloadLocked() {
    setSyncCount((n) => n + 1);
    try {
      await load();
    } catch (e) {
      setError(String(e)); // 回拉失败必须可见:DB 可能已变,旧快照不再可信
    } finally {
      setSyncCount((n) => n - 1);
    }
  }

  async function addLink() {
    setCreating(true); // creating 锁:url 无唯一约束,慢网双击的重复创建只能在入口挡
    try {
      const created = await api<PlaceLink>(`/admin/places/${id}/links`, {
        method: "POST",
        body: JSON.stringify({ platform, title, url, sortOrder, tagId: tagId || null }),
      });
      setPlace((prev) => prev && { ...prev, links: [...prev.links, created].sort(byOrder) });
      setTitle(""); setUrl(""); setSortOrder(0); setTagId(""); setError("");
    } catch (e) { setError(String(e)); await reloadLocked(); }
    setCreating(false);
  }

  // 打标:PATCH 响应即权威值,函数式局部合并;本页初始加载后没有锁外整页 GET
  async function saveTag(linkId: string, nextTagId: string) {
    setBusy(linkId, true);
    try {
      const updated = await api<PlaceLink>(`/admin/links/${linkId}`, {
        method: "PATCH", body: JSON.stringify({ tagId: nextTagId || null }),
      });
      setPlace((prev) => prev && {
        ...prev, links: prev.links.map((l) => (l.id === linkId ? updated : l)),
      });
      setError("");
    } catch (e) {
      setError(String(e));
      await reloadLocked(); // 失败:写锁下回拉;select 受控,重渲染即复位
    }
    setBusy(linkId, false);
  }

  // 排序:平序组内真序在服务端(createdAt),成功与失败都在写锁下回拉
  async function saveOrder(linkId: string, next: number) {
    setBusy(linkId, true);
    try {
      await api(`/admin/links/${linkId}`, { method: "PATCH", body: JSON.stringify({ sortOrder: next }) });
      setError("");
    } catch (e) { setError(String(e)); }
    clearOrderDraft(linkId); // 丢弃草稿,受控输入随回拉后的 state 复位
    await reloadLocked();
    setBusy(linkId, false);
  }

  async function removeLink(linkId: string) {
    setBusy(linkId, true);
    try {
      await api(`/admin/links/${linkId}`, { method: "DELETE" });
      setPlace((prev) => prev && { ...prev, links: prev.links.filter((l) => l.id !== linkId) });
      setError("");
    } catch (e) { setError(String(e)); await reloadLocked(); }
    setBusy(linkId, false);
  }

  if (!place) return <p>{error || "加载中…"}</p>;
  const untagged = place.links.filter((l) => !l.tag).length;
  return (
    <>
      <h2>
        {place.ancestors.map((a) => a.name).concat(place.name).join(" · ")}
        ｜网友分享外链（{place.links.length}，未打标 {untagged}）
      </h2>
      <p><Link href="/link-tags">管理标签 →</Link></p>
      {error && <p style={{ color: "red" }}>{error}</p>}
      <table>
        <thead><tr><th>排序</th><th>平台</th><th>标题</th><th>链接</th><th>标签</th><th>操作</th></tr></thead>
        <tbody>
          {place.links.map((l) => (
            <tr key={l.id}>
              <td>
                <input
                  type="number" style={{ width: 64 }}
                  value={orderDrafts[l.id] ?? String(l.sortOrder)}
                  disabled={locked(l.id)}
                  onChange={(e) => setOrderDrafts((prev) => ({ ...prev, [l.id]: e.target.value }))}
                  onBlur={() => {
                    const next = Number(orderDrafts[l.id] ?? String(l.sortOrder));
                    if (Number.isInteger(next) && next >= 0 && next !== l.sortOrder) {
                      void saveOrder(l.id, next);
                    } else clearOrderDraft(l.id);
                  }}
                />
              </td>
              <td>{PLATFORM_LABELS[l.platform] ?? l.platform}</td>
              <td>{l.title}</td>
              <td><a href={l.url} target="_blank" rel="noreferrer">{l.url}</a></td>
              <td>
                <select
                  value={l.tag?.id ?? ""} disabled={locked(l.id)}
                  onChange={(e) => saveTag(l.id, e.target.value)}
                >
                  <option value="">（无标签）</option>
                  {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </td>
              <td><button onClick={() => removeLink(l.id)} disabled={locked(l.id)}>删除</button></td>
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
        <select value={tagId} onChange={(e) => setTagId(e.target.value)}>
          <option value="">（无标签）</option>
          {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>{" "}
        <button onClick={addLink} disabled={creating || syncing || !title || !url.trim().startsWith("https://")}>添加</button>
      </p>
    </>
  );
}
