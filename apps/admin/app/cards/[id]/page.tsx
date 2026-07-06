"use client";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

type Block = { id: string; order: number; type: string; text: string | null; mediaUrl: string | null };
type Card = {
  id: string; title: string; category: string; status: string;
  sources: string[]; blocks: Block[]; place: { name: string };
};

export default function CardDetail() {
  const { id } = useParams<{ id: string }>();
  const [card, setCard] = useState<Card | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api<Card>(`/cards/${id}`).then(setCard).catch((e) => setError(String(e)));
  }, [id]);
  useEffect(load, [load]);

  async function transition(action: "review" | "retire") {
    try {
      await api(`/admin/cards/${id}/status`, { method: "POST", body: JSON.stringify({ action }) });
      load();
    } catch (e) {
      setError(String(e));
    }
  }

  if (!card) return <p>{error || "加载中…"}</p>;
  return (
    <>
      <h2>
        {card.title} <span className={`badge ${card.status}`}>{card.status}</span>
      </h2>
      <p>地点：{card.place.name}｜分类：{card.category}</p>
      <p>
        {card.status === "AI_GENERATED" && (
          <button onClick={() => transition("review")}>标记已复核</button>
        )}{" "}
        {card.status !== "RETIRED" && <button onClick={() => transition("retire")}>下架</button>}
      </p>
      {error && <p style={{ color: "red" }}>{error}</p>}
      {card.blocks.map((b) => (
        <div className="card-block" key={b.id}>
          {b.type === "TEXT" ? b.text : `[${b.type}] ${b.mediaUrl ?? ""}`}
        </div>
      ))}
      <h4>参考来源</h4>
      <ul>{card.sources.map((s, i) => <li key={i}>{s}</li>)}</ul>
    </>
  );
}
