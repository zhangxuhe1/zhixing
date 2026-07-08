"use client";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

type Photo = { photoId: string; url: string };
type ReviewItem = {
  footprintId: string;
  text: string | null;
  date: string;
  authorNickname: string;
  placeName: string;
  publicRequestedAt: string | null;
  photos: Photo[];
};

export default function ReviewPage() {
  const [total, setTotal] = useState(0);
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    api<{ total: number; items: ReviewItem[] }>("/admin/review-queue")
      .then((data) => {
        setTotal(data.total);
        setItems(data.items);
      })
      .catch((e) => setError(String(e)));
  }, []);
  useEffect(load, [load]);

  async function review(footprintId: string, action: "approve" | "reject") {
    try {
      await api(`/admin/review/${footprintId}`, { method: "POST", body: JSON.stringify({ action }) });
      setItems((prev) => prev.filter((i) => i.footprintId !== footprintId));
      setTotal((prev) => prev - 1);
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <>
      <h2>审核队列（积压 {total}）</h2>
      {error && <p style={{ color: "red" }}>{error}</p>}
      {items.map((item) => (
        <div className="card-block" key={item.footprintId}>
          <p>
            {item.placeName}｜{item.authorNickname}｜{new Date(item.date).toLocaleString("zh-CN")}
          </p>
          {item.text && <p>{item.text}</p>}
          {item.photos.length > 0 && (
            <p>
              {item.photos.map((p) => (
                <img
                  key={p.photoId}
                  src={p.url}
                  alt=""
                  style={{ width: 96, height: 96, objectFit: "cover", marginRight: 8 }}
                />
              ))}
            </p>
          )}
          <p>
            <button onClick={() => review(item.footprintId, "approve")}>通过</button>{" "}
            <button onClick={() => review(item.footprintId, "reject")}>拒绝</button>
          </p>
        </div>
      ))}
      {items.length === 0 && !error && <p>暂无待审内容。</p>}
    </>
  );
}
