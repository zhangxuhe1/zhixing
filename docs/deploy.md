# M1 内测部署 Runbook（海外 VPS，规格书 D6：内测期免备案）

## 需要你先决定/准备的（无法代办）
1. 域名一个（示例 zhixing.example.com），DNS 加 A 记录：api / admin / s3 三个子域指向 VPS IP
2. 海外 VPS 一台（2C4G 起步，香港/日本/新加坡节点对国内测试者延迟友好）
3. Apple Developer Program（¥688/年，TestFlight 必需）——bundle id 定稿后同步改 APPLE_BUNDLE_ID

## 步骤
1. VPS 装 Docker（官方脚本），git clone 本仓库
2. `cp .env.production.example .env.production`，全部密钥换 `openssl rand -hex 24` 生成值
3. `docker compose -f compose.prod.yml --env-file .env.production up -d --build`
4. 验证：`curl https://api.<域名>/health` → `{"ok":true}`；浏览器打开 `https://admin.<域名>`
5. 灌数据：在 VPS 上 `DATABASE_URL=postgresql://zhixing:<密码>@localhost:5432/zhixing` 无法直连
   （db 未暴露端口）——用 `docker compose -f compose.prod.yml exec api sh` 进容器跑
   `pnpm --filter @zhixing/pipeline import-places && pnpm --filter @zhixing/pipeline import-regions`，
   或本地生成后 `pg_dump | psql` 导入（推荐：内容在本地生成复核，dump 上传）。推荐路径的精确命令：

   ```sh
   # 本地 Mac：整库导出（LLM Key 与配额只留本地，生产不需要 GEMINI_API_KEY）
   docker exec zhixing-db-1 pg_dump -U zhixing zhixing | gzip > zhixing-content.sql.gz
   scp zhixing-content.sql.gz <vps>:~/zhixing/

   # VPS（步骤 3 已起服务、migrate deploy 已建表）：导入 + 清掉本地测试数据只留内容
   gunzip -c zhixing-content.sql.gz | docker compose -f compose.prod.yml exec -T db psql -U zhixing zhixing
   docker compose -f compose.prod.yml exec -T db psql -U zhixing zhixing \
     -c 'TRUNCATE TABLE "FootprintPhoto","Footprint","User","SearchMiss" RESTART IDENTITY CASCADE'
   ```

   适用前提：生产库还没有真实用户数据（首次部署/内测重置）。一旦有真实用户，禁止整库覆盖，
   改为只导内容三表：`pg_dump --data-only --disable-triggers -t '"Place"' -t '"Card"' -t '"CardBlock"'`
   （容器内 zhixing 用户是超级用户，--disable-triggers 可用；导入前先在后台确认无 placeId 冲突）
6. crontab 加 `scripts/backup.sh` 每日备份
7. 安全检查：ADMIN_TOKEN/SESSION_SECRET 已换强值；`ZHIXING_DEV_AUTH` 未设置；
   db/minio 无宿主端口暴露；只有 caddy 开 80/443

## 说明
- MinIO 生产可换 Cloudflare R2 / 阿里云 OSS：只改 S3_* 五个环境变量，代码零改动
- 公开上线（M4）前迁国内云 + 备案，见规格书 §5.2，本 runbook 不覆盖

## 部署前硬化清单（M1 终审建议，首次部署时执行）

- [ ] 备份含照片：backup.sh 目前只 pg_dump——首次部署时把 minio-data 卷纳入备份（如 `docker run --rm -v zhixing_minio-data:/data -v $PWD/backups:/backup alpine tar czf /backup/minio-$(date +%Y%m%d).tar.gz /data`）
- [ ] 启动断言：SESSION_SECRET / ADMIN_TOKEN / S3_SECRET_KEY 为 change-me、空串或 dev 默认值时 api 拒绝启动（compose 缺变量会替换成空串，`??` 捕不到）
- [ ] compose 健康检查：db/minio 加 healthcheck，api `depends_on.condition: service_healthy`，避免首启 migrate 竞态
- [ ] 统一错误形状：Fastify setErrorHandler 把框架级 404/413/500 也收敛到 `{error:"..."}`（现仅应用级错误统一）
