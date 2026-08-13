"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useLockedReload } from "@/lib/useLockedReload";

type LinkTag = { id: string; name: string };
type AdminLink = {
  id: string; platform: string; title: string; url: string; sortOrder: number;
  tag: LinkTag | null; place: { id: string; path: string };
};
// PATCH /admin/links/:id 的响应形状(LINK_SELECT,无 place)
type PatchedLink = { id: string; tag: LinkTag | null };
type TagOption = { id: string; name: string; sortOrder: number; linkCount: number };

const PLATFORM_LABELS: Record<string, string> = {
  XIAOHONGSHU: "小红书", BILIBILI: "B 站", DOUYIN: "抖音", WEIBO: "微博", OTHER: "其他",
};

export default function LinksPage() {
  const [items, setItems] = useState<AdminLink[] | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [tags, setTags] = useState<TagOption[]>([]);
  const [onlyUntagged, setOnlyUntagged] = useState(false);
  const [error, setError] = useState("");

  // 双 GET 原子提交:先拿齐两份结果再一起 setState,不提交半份快照(不允许"链接更新了、
  // 标签列表还是旧的/空的");失败向上抛,由初始 effect / reloadLocked 决定如何呈现
  const load = useCallback(async () => {
    const [linkList, tagList] = await Promise.all([
      api<{ items: AdminLink[] }>("/admin/links"),
      api<TagOption[]>("/admin/link-tags"),
    ]);
    setItems(linkList.items);
    setTags(tagList);
  }, []);
  useEffect(() => { void load().catch((e) => setError(String(e))); }, [load]);

  // 写锁与「快照失效」告警见 useLockedReload:staleError 与 error 独立,只随整页回拉成功/失败翻转
  const { syncing, staleError, reloadLocked } = useLockedReload(load);

  async function saveTag(linkId: string, tagId: string) {
    setBusyIds((prev) => new Set(prev).add(linkId)); // 在途时禁用该行,同链接操作物理串行
    try {
      const updated = await api<PatchedLink>(`/admin/links/${linkId}`, {
        method: "PATCH", body: JSON.stringify({ tagId: tagId || null }),
      });
      // PATCH 响应即权威值:函数式局部合并,本页初始加载后没有锁外整页 GET
      setItems((prev) => prev && prev.map((l) => (l.id === linkId ? { ...l, tag: updated.tag } : l)));
      setError("");
    } catch (e) {
      setError(String(e));
      await reloadLocked(); // 失败:写锁下回拉服务端真相;select 受控,重渲染即复位
    } finally {
      setBusyIds((prev) => { const next = new Set(prev); next.delete(linkId); return next; });
    }
  }

  if (!items) return <p>{error || "加载中…"}</p>;
  const untagged = items.filter((l) => !l.tag).length;
  const shown = onlyUntagged ? items.filter((l) => !l.tag) : items;
  return (
    <>
      <h2>外链总览（{items.length}，未打标 {untagged}）</h2>
      <p>
        <label>
          <input
            type="checkbox" checked={onlyUntagged}
            onChange={(e) => setOnlyUntagged(e.target.checked)}
          /> 只看未打标
        </label>
        {" ｜ "}
        <Link href="/link-tags">管理标签 →</Link>
      </p>
      {staleError && <p style={{ color: "red" }}>同步服务端最新状态失败，页面可能停留在旧数据，请刷新页面（{staleError}）</p>}
      {error && <p style={{ color: "red" }}>{error}</p>}
      <table>
        <thead><tr><th>地点</th><th>平台</th><th>标题</th><th>链接</th><th>标签</th></tr></thead>
        <tbody>
          {shown.map((l) => (
            <tr key={l.id}>
              <td><Link href={`/places/${l.place.id}`}>{l.place.path}</Link></td>
              <td>{PLATFORM_LABELS[l.platform] ?? l.platform}</td>
              <td>{l.title}</td>
              <td><a href={l.url} target="_blank" rel="noreferrer">{l.url}</a></td>
              <td>
                <select
                  value={l.tag?.id ?? ""} disabled={syncing || busyIds.has(l.id)}
                  onChange={(e) => saveTag(l.id, e.target.value)}
                >
                  <option value="">（无标签）</option>
                  {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
