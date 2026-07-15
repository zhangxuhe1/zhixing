"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

type PendingPlace = {
  id: string;
  name: string;
  lat: number;
  lng: number;
  createdAt: string;
  parentId: string | null;
  parentName: string | null;
  creatorNickname: string;
};

type Place = { id: string; name: string; level: string; status: string };

type PlaceEdit = { name: string; parentId: string; mergeTargetId: string };

export default function PendingPlacesPage() {
  const [items, setItems] = useState<PendingPlace[]>([]);
  const [places, setPlaces] = useState<Place[]>([]);
  const [error, setError] = useState("");
  const [edits, setEdits] = useState<Record<string, PlaceEdit>>({});

  const load = useCallback(() => {
    api<{ total: number; items: PendingPlace[] }>("/admin/places/pending")
      .then((data) => {
        setItems(data.items);
        setEdits(Object.fromEntries(data.items.map((item) => [
          item.id,
          { name: item.name, parentId: item.parentId ?? "", mergeTargetId: "" },
        ])));
      })
      .catch((e) => setError(String(e)));
    api<Place[]>("/places").then(setPlaces).catch((e) => setError(String(e)));
  }, []);

  useEffect(load, [load]);

  async function decide(id: string, payload: object) {
    try {
      setError("");
      await api(`/admin/places/${id}/decision`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setItems((previous) => previous.filter((item) => item.id !== id));
    } catch (e) {
      setError(String(e));
    }
  }

  async function merge(id: string, targetId: string) {
    try {
      setError("");
      await api(`/admin/places/${id}/merge`, {
        method: "POST",
        body: JSON.stringify({ targetId }),
      });
      setItems((previous) => previous.filter((item) => item.id !== id));
    } catch (e) {
      setError(String(e));
    }
  }

  const parentOptions = places.filter(
    (place) => place.status === "ACTIVE" && (place.level === "CITY" || place.level === "PROVINCE"),
  );
  const mergeOptions = places.filter((place) => place.status === "ACTIVE");

  return (
    <>
      <h2>地点审核（积压 {items.length}）</h2>
      {error && <p style={{ color: "red" }}>{error}</p>}
      {items.map((item) => {
        const edit = edits[item.id] ?? {
          name: item.name,
          parentId: item.parentId ?? "",
          mergeTargetId: "",
        };
        const set = (patch: Partial<PlaceEdit>) =>
          setEdits((previous) => ({
            ...previous,
            [item.id]: { ...edit, ...patch },
          }));

        return (
          <div className="card-block" key={item.id}>
            <p>
              <strong>{item.name}</strong>｜{item.creatorNickname}｜
              {item.lat.toFixed(4)}, {item.lng.toFixed(4)}｜
              {new Date(item.createdAt).toLocaleString("zh-CN")}｜
              自动挂靠:{item.parentName ?? "(未命中)"}
            </p>
            <p>
              名称 <input value={edit.name} onChange={(e) => set({ name: e.target.value })} />{" "}
              父级{" "}
              <select value={edit.parentId} onChange={(e) => set({ parentId: e.target.value })}>
                <option value="">(链顶)</option>
                {parentOptions.map((place) => (
                  <option key={place.id} value={place.id}>{place.name}</option>
                ))}
              </select>{" "}
              <button onClick={() => decide(item.id, {
                action: "approve",
                name: edit.name,
                parentId: edit.parentId || null,
              })}>
                通过
              </button>{" "}
              <button onClick={() => decide(item.id, { action: "reject" })}>拒绝</button>
            </p>
            <p>
              合并到{" "}
              <select
                value={edit.mergeTargetId}
                onChange={(e) => set({ mergeTargetId: e.target.value })}
              >
                <option value="">(选择已有地点)</option>
                {mergeOptions.map((place) => (
                  <option key={place.id} value={place.id}>{place.name}</option>
                ))}
              </select>{" "}
              <button
                disabled={!edit.mergeTargetId}
                onClick={() => merge(item.id, edit.mergeTargetId)}
              >
                合并（足迹随迁）
              </button>
            </p>
          </div>
        );
      })}
      {items.length === 0 && <p>暂无待审地点。</p>}
    </>
  );
}
