export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8787";

export function getToken(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("zx_admin_token") ?? "";
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${getToken()}`,
      ...(init.headers ?? {}),
    },
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}
