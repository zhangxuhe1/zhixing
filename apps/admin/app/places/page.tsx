"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/lib/api";

type Place = { id: string; name: string; level: string; parentId: string | null; lat: number; lng: number };

export default function PlacesPage() {
  const [places, setPlaces] = useState<Place[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    api<Place[]>("/places").then(setPlaces).catch((e) => setError(String(e)));
  }, []);
  return (
    <>
      <h2>地点库（{places.length}）</h2>
      {error && <p style={{ color: "red" }}>{error}</p>}
      <table>
        <thead><tr><th>名称</th><th>层级</th><th>坐标</th><th>操作</th></tr></thead>
        <tbody>
          {places.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td>{p.level}</td>
              <td>{p.lat.toFixed(3)}, {p.lng.toFixed(3)}</td>
              <td><Link href={`/places/${p.id}`}>外链</Link></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
