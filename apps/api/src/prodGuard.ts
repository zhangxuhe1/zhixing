/**
 * 生产启动断言（docs/deploy.md 部署前硬化清单第 1 项）。
 *
 * compose 缺变量时 `${VAR}` 会被替换成空串，config.ts 的 `??` 兜底捕不到——
 * 这正是空串必须入弱值集合的原因。其余弱值与 config.ts 的 dev 默认值、
 * .env.production.example 的 change-me 占位值一一对应。
 *
 * 仅 server.ts 在 NODE_ENV=production 时调用；buildApp/测试/本地 dev 不受影响
 * （本地 dev 正是靠 dev 默认值零配置起跑的，断言无条件生效会废掉它）。
 */
const WEAK_VALUES = new Set([
  "", // compose 缺变量替换产物（trim 后比较，纯空白同罪）
  "change-me", // .env.production.example 占位值
  "dev-session-secret", // config.ts dev 默认值 ↓
  "dev-admin-token",
  "zhixing-secret",
]);

/** 返回命中弱值的键名（按对象键序）；全强则空数组。 */
export function findWeakSecrets(secrets: {
  SESSION_SECRET: string;
  ADMIN_TOKEN: string;
  S3_SECRET_KEY: string;
}): string[] {
  return Object.entries(secrets)
    .filter(([, value]) => WEAK_VALUES.has(value.trim()))
    .map(([key]) => key);
}
