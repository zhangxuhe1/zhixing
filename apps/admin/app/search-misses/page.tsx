"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

type Miss = { id: string; query: string; count: number; lastAt: string };

export default function SearchMissesPage() {
  const [misses, setMisses] = useState<Miss[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    api<Miss[]>("/admin/search-misses").then(setMisses).catch((e) => setError(String(e)));
  }, []);
  return (
    <>
      <h2>搜索缺失（按需补内容的依据）</h2>
      {error && <p style={{ color: "red" }}>{error}</p>}
      <table>
        <thead><tr><th>查询词</th><th>次数</th><th>最近</th></tr></thead>
        <tbody>
          {misses.map((m) => (
            <tr key={m.id}>
              <td>{m.query}</td>
              <td>{m.count}</td>
              <td>{new Date(m.lastAt).toLocaleString("zh-CN")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
