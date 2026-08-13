"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useLockedReload } from "@/lib/useLockedReload";

type TagRow = { id: string; name: string; sortOrder: number; linkCount: number };
// POST/PATCH /admin/link-tags 的响应形状(POST 额外带 linkCount: 0)
type TagDto = { id: string; name: string; sortOrder: number };

// Array.prototype.sort 是稳定排序:平序保持既有相对顺序(≈ 服务端的 createdAt 次序)
const byOrder = (a: TagRow, b: TagRow) => a.sortOrder - b.sortOrder;

export default function LinkTagsPage() {
  const [tags, setTags] = useState<TagRow[] | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({}); // 受控草稿,key = `${id}:${field}`
  const [error, setError] = useState("");
  const [name, setName] = useState("");

  // load 不自吞错误:失败向上抛,由初始 effect / reloadLocked 决定如何呈现
  const load = useCallback(async () => {
    setTags(await api<TagRow[]>("/admin/link-tags"));
  }, []);
  useEffect(() => { void load().catch((e) => setError(String(e))); }, [load]);

  // 写锁与「快照失效」告警见 useLockedReload:staleError 与 error 独立,只随整页回拉成功/失败翻转
  const { syncing, staleError, reloadLocked } = useLockedReload(load);

  const locked = (id: string) => syncing || busyIds.has(id);
  function setBusy(id: string, on: boolean) {
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  }
  const draftOf = (id: string, field: string, fallback: string) => drafts[`${id}:${field}`] ?? fallback;
  const setDraft = (id: string, field: string, v: string) =>
    setDrafts((prev) => ({ ...prev, [`${id}:${field}`]: v }));
  const clearDraft = (id: string) =>
    setDrafts((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => !k.startsWith(`${id}:`))));

  async function create() {
    setCreating(true); // creating 锁:慢网双击不会重复创建
    try {
      const created = await api<TagDto>("/admin/link-tags", {
        method: "POST", body: JSON.stringify({ name: name.trim() }),
      });
      setTags((prev) => prev && [...prev, { ...created, linkCount: 0 }].sort(byOrder));
      setName(""); setError("");
    } catch (e) { setError(String(e)); await reloadLocked(); }
    setCreating(false);
  }

  async function patch(id: string, data: { name?: string; sortOrder?: number }) {
    setBusy(id, true);
    try {
      const updated = await api<TagDto>(`/admin/link-tags/${id}`, {
        method: "PATCH", body: JSON.stringify(data),
      });
      clearDraft(id);
      setError(""); // 只清普通写入错误;「快照失效」告警由 useLockedReload 独立持有,这里碰不到
      if (data.sortOrder !== undefined) {
        await reloadLocked(); // 排序:平序组内真序在服务端(createdAt),锁页回拉
      } else {
        setTags((prev) => prev && prev.map((t) => (t.id === id ? { ...t, ...updated } : t)));
      }
    } catch (e) {
      setError(String(e));
      clearDraft(id); // 丢弃草稿,受控输入随 state 复位为服务端值
      await reloadLocked();
    }
    setBusy(id, false);
  }

  async function remove(id: string) {
    setBusy(id, true);
    try {
      await api(`/admin/link-tags/${id}`, { method: "DELETE" });
      setTags((prev) => prev && prev.filter((t) => t.id !== id));
      setError("");
    } catch (e) { setError(String(e)); await reloadLocked(); }
    setBusy(id, false);
  }

  if (!tags) return <p>{error || "加载中…"}</p>;
  return (
    <>
      <h2>外链标签（{tags.length}）</h2>
      <p>标签用于给外链分类（如「实用攻略」「旅行记录」）；改名即时全局生效，被引用的标签不可删除。</p>
      {staleError && <p style={{ color: "red" }}>同步服务端最新状态失败，页面可能停留在旧数据，请刷新页面（{staleError}）</p>}
      {error && <p style={{ color: "red" }}>{error}</p>}
      <table>
        <thead><tr><th>排序</th><th>名称</th><th>引用数</th><th>操作</th></tr></thead>
        <tbody>
          {tags.map((t) => (
            <tr key={t.id}>
              <td>
                <input
                  type="number" style={{ width: 64 }}
                  value={draftOf(t.id, "sort", String(t.sortOrder))}
                  disabled={locked(t.id)}
                  onChange={(e) => setDraft(t.id, "sort", e.target.value)}
                  onBlur={() => {
                    const next = Number(draftOf(t.id, "sort", String(t.sortOrder)));
                    if (Number.isInteger(next) && next >= 0 && next !== t.sortOrder) {
                      void patch(t.id, { sortOrder: next });
                    } else clearDraft(t.id);
                  }}
                />
              </td>
              <td>
                <input
                  maxLength={12}
                  value={draftOf(t.id, "name", t.name)}
                  disabled={locked(t.id)}
                  onChange={(e) => setDraft(t.id, "name", e.target.value)}
                  onBlur={() => {
                    const next = draftOf(t.id, "name", t.name).trim();
                    if (next && next !== t.name) void patch(t.id, { name: next });
                    else clearDraft(t.id);
                  }}
                />
              </td>
              <td>{t.linkCount}</td>
              <td>
                <button
                  onClick={() => remove(t.id)} disabled={locked(t.id) || t.linkCount > 0}
                  title={t.linkCount > 0 ? "仍有外链使用该标签，先改标或清空" : undefined}
                >删除</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h3>新增标签</h3>
      <p>
        <input placeholder="如：实用攻略" value={name} maxLength={12} onChange={(e) => setName(e.target.value)} />{" "}
        <button onClick={create} disabled={creating || syncing || !name.trim()}>添加</button>
      </p>
    </>
  );
}
