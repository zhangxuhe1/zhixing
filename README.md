# 知行 zhixing

一张有故事的中国地图。产品设计见 docs/superpowers/specs/2026-07-06-zhixing-design.md。

## 开发

```sh
pnpm install
pnpm db:up                      # 启动 Postgres（zhixing + zhixing_test 两个库）
pnpm --filter @zhixing/db exec prisma migrate dev   # 建表
pnpm --filter @zhixing/api dev  # API :8787
pnpm --filter @zhixing/admin dev # 管理后台 :3000
pnpm test                       # 全部测试
```
