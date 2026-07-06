"use client";
import { useEffect, useState } from "react";

export function TokenBar() {
  const [token, setToken] = useState("");
  useEffect(() => setToken(localStorage.getItem("zx_admin_token") ?? ""), []);
  return (
    <span style={{ marginLeft: "auto" }}>
      <input
        type="password"
        placeholder="ADMIN_TOKEN"
        value={token}
        onChange={(e) => {
          setToken(e.target.value);
          localStorage.setItem("zx_admin_token", e.target.value);
        }}
        style={{ padding: 4 }}
      />
    </span>
  );
}
