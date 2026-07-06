import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// 自动加载仓库根目录的 .env（cp .env.example .env 后填写）；不存在则跳过，保持零配置可跑
const envPath = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);
