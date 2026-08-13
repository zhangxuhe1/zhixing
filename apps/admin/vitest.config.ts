import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.dirname(fileURLToPath(import.meta.url)) } },
  esbuild: { jsx: "automatic" },
  test: { environment: "jsdom", fileParallelism: false },
});
