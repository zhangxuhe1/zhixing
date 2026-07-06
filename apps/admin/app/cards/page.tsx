"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

type Place = { id: string; name: string };
type Card = { id: string; title: string; category: string; status: string; placeId: string };

const CATEGORY_ZH: Record<string, string> = {
  CUSTOMS: "习俗", FOOD: "吃食", DIALECT: "方言", ANECDOTE: "掌故", PLACE_NAME: "地名由来",
};

export default function CardsPage() {
  const [places, setPlaces] = useState<Place[]>([]);
  const [placeId, setPlaceId] = useState("");
  const [cards, setCards] = useState<Card[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    api<Place[]>("/places").then((ps) => {
      setPlaces(ps);
      if (ps.length > 0) setPlaceId(ps[0].id);
    }).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!placeId) return;
    api<Card[]>(`/places/${placeId}/cards`).then(setCards).catch((e) => setError(String(e)));
  }, [placeId]);

  return (
    <>
      <h2>风物卡</h2>
      {error && <p style={{ color: "red" }}>{error}</p>}
      <p>
        地点：
        <select value={placeId} onChange={(e) => setPlaceId(e.target.value)}>
          {places.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </p>
      <table>
        <thead><tr><th>标题</th><th>分类</th><th>状态</th></tr></thead>
        <tbody>
          {cards.map((c) => (
            <tr key={c.id}>
              <td><Link href={`/cards/${c.id}`}>{c.title}</Link></td>
              <td>{CATEGORY_ZH[c.category] ?? c.category}</td>
              <td><span className={`badge ${c.status}`}>{c.status}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
