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

## SMTP 配置（邮箱验证码登录）

- `SMTP_URL`：`smtps://user:pass@host:465` 格式连接串，直接交给 nodemailer 建立发信连接；留空时验证码只打印到 api 容器日志，不会真的发出邮件——这是 dev/test 默认，生产环境要让邮箱登录真正可用，必须配置这个变量
- `MAIL_FROM`：发件人，格式「显示名 <地址>」，默认 `知行 <noreply@example.com>`；改用自有发信地址时一并改这里
- 发信域名（`MAIL_FROM` 里 @ 后的域名）需要在 DNS 配好 SPF/DKIM，否则验证码邮件大概率被目标邮箱服务商（尤其 QQ/163/Gmail）打入垃圾箱或直接拒收

## 部署前硬化清单（M1 终审建议，首次部署时执行）

- [ ] 备份含照片：backup.sh 目前只 pg_dump——首次部署时把 minio-data 卷纳入备份（如 `docker run --rm -v zhixing_minio-data:/data -v $PWD/backups:/backup alpine tar czf /backup/minio-$(date +%Y%m%d).tar.gz /data`）
- [x] 启动断言：SESSION_SECRET / ADMIN_TOKEN / S3_SECRET_KEY 为 change-me、空串或 dev 默认值时 api 拒绝启动（compose 缺变量会替换成空串，`??` 捕不到）——已实现于 apps/api/src/prodGuard.ts + server.ts，由 compose 注入的 NODE_ENV=production 触发
- [x] compose 健康检查：db/minio 加 healthcheck，api `depends_on.condition: service_healthy`，避免首启 migrate 竞态——compose.prod.yml 已补齐（db pg_isready + minio `mc ready local`，api 两依赖均 service_healthy）
- [ ] 统一错误形状：Fastify setErrorHandler 把框架级 404/413/500 也收敛到 `{error:"..."}`（现仅应用级错误统一）

## 部署前清单追加（M2 服务端验收）

- [ ] 限流参数确认：`TRUST_PROXY=1` 必须开启——api 在 Caddy/Nginx 反代之后，不开则所有请求
      按代理 IP 落进同一个限流桶，任何一个用户都能把全站打进 429（直连部署则必须保持 0，
      防伪造 X-Forwarded-For 绕过按 IP 限流）。当前档位：全局 300/min（按 Authorization 头，
      无头按 IP）、`/search` 30/min·IP、`/auth/*` 10/min·IP、点赞/浏览 60/min；档位在代码里
      （apps/api/src/app.ts 与各路由），动态配置化在 M2 范围外，放量前按需改码调档
- [ ] `SHARE_LANDING_URL` 换成正式落地页地址（`GET /app-config` 下发给 iOS 作分享链接；
      example 里是占位符 `https://zhixing.example.com/beta`）
- [ ] 设计备案——账号删除与 likeCount：Like 对 User 是 onDelete: Cascade，将来上线"账号删除"
      功能时，其点赞记录会被级联删除而足迹上去规范化的 likeCount 计数器不会随之扣减，导致
      计数漂移。删除流程必须同步重算受影响足迹的 likeCount（按 Like 表实数回填）

## 已知限制（M2 备案，非缺陷）

- 昵称变更不过审核：登录（`POST /auth/apple` / dev 旁路）携带 nickname 即直接生效，公开故事
  的作者昵称随之变化——内容安全（含昵称机审）由 M3 统一处理
- 照片无单张 DELETE 端点：M2 范围外；删除照片目前只能删除整条足迹（级联清理照片与对象存储）
