"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

type Report = {
  id: string;
  cardId: string;
  cardTitle: string;
  text: string;
  status: string;
  createdAt: string;
};

export default function ReportsPage() {
  const [reports, setReports] = useState<Report[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api<{ items: Report[] }>("/admin/reports?status=OPEN")
      .then((data) => setReports(data.items))
      .catch((e) => setError(String(e)));
  }, []);
  useEffect(load, [load]);

  async function resolve(id: string) {
    try {
      await api(`/admin/reports/${id}`, { method: "PATCH", body: JSON.stringify({ status: "RESOLVED" }) });
      setReports((prev) => prev.filter((r) => r.id !== id));
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <>
      <h2>卡片报错（待处理 {reports.length}）</h2>
      {error && <p style={{ color: "red" }}>{error}</p>}
      <table>
        <thead>
          <tr>
            <th>卡片</th>
            <th>报错内容</th>
            <th>提交时间</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {reports.map((r) => (
            <tr key={r.id}>
              <td><Link href={`/cards/${r.cardId}`}>{r.cardTitle}</Link></td>
              <td>{r.text}</td>
              <td>{new Date(r.createdAt).toLocaleString("zh-CN")}</td>
              <td><button onClick={() => resolve(r.id)}>标记已处理</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
