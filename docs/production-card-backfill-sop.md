# 生产环境零卡地点补卡 SOP

适用场景：运营人员在生产管理后台新增地点后，这些地点因为没有未下架风物卡，
在用户端人文地图上不显示。目标是给选定范围内的零卡地点暂时补到每地 1 张卡。

本 SOP 默认在生产服务器的仓库根目录执行。生产部署使用 `.env.production`，
LLM 凭据和模型配置来自根目录 `.env`：

- `GEMINI_API_KEY`
- `DEEPSEEK_API_KEY`
- `ZHIXING_LLM_PROVIDER=gemini` 或 `deepseek`
- `ZHIXING_GEN_MODEL`

不要打印、复制到命令行字面量或提交任何 API Key。

## 一、行为与范围

- 地图人文层只显示 `cardCount > 0` 的地点。
- “有效卡”指状态不是 `RETIRED` 的卡；只有已下架卡的地点仍算零卡地点。
- `batch -- --fill 1` 扫描**所有层级**，包括 `PROVINCE`、`CITY`、`DISTRICT`
  和 `POI`，不是只扫描后台手工输入的 POI。
- 命令只补不足 1 张的地点，已有有效卡的地点不会新增；失败后可原样重跑。
- 当前分类轮转从 `CUSTOMS` 开始，因此零卡地点统一补 1 张时，首张通常都是“习俗”。
- 管线仍按地点名查找目标；执行前必须确认不存在重名地点。

如果只想补 POI、某个日期后的地点或人工挑选的一组地点，不能直接跑全库 batch。
应先列出目标，再逐个执行 `generate -- --place ...`，或先为 batch 实现相应筛选参数。

## 二、执行前只读检查

### 1. 服务状态

```sh
docker compose -f compose.prod.yml --env-file .env.production ps
curl -fsS https://api.example.com/health
```

期望 API、Admin 为 `Up`，PostgreSQL、MinIO 为 `healthy`，健康接口返回
`{"ok":true}`。

### 2. LLM 配置

只输出配置是否存在和模型名，不输出 Key：

```sh
awk -F= '/^(GEMINI_API_KEY|DEEPSEEK_API_KEY|ZHIXING_GEN_MODEL|ZHIXING_LLM_PROVIDER)=/{
  if ($1 ~ /_API_KEY$/) print $1 "=present"; else print $0
}' .env
```

生产 API 容器本身不会注入 LLM 凭据，且镜像构建时 `.env` 被 `.dockerignore`
排除。后文会从 `.env` 过滤出上述四个 LLM 变量，通过临时文件送进一次性容器；不能把
整个 `.env` 注入生产容器，也不能直接在常驻 API 容器里运行 batch。

### 3. 统计零卡地点

```sh
docker compose -f compose.prod.yml --env-file .env.production exec -T db \
  psql -U zhixing -d zhixing -P pager=off -c '
WITH place_cards AS (
  SELECT p.id, p.name, p.level, p."parentId", p."createdAt",
         COUNT(c.id) FILTER (WHERE c.status <> '\''RETIRED'\'') AS active_cards
  FROM "Place" p
  LEFT JOIN "Card" c ON c."placeId" = p.id
  GROUP BY p.id
)
SELECT level,
       COUNT(*) AS places,
       COUNT(*) FILTER (WHERE active_cards = 0) AS without_active_cards
FROM place_cards
GROUP BY level
ORDER BY level;'
```

列出具体零卡地点及父级：

```sh
docker compose -f compose.prod.yml --env-file .env.production exec -T db \
  psql -U zhixing -d zhixing -P pager=off -c '
SELECT p.id, p.name, p.level, parent.name AS parent_name, p."createdAt"
FROM "Place" p
LEFT JOIN "Place" parent ON parent.id = p."parentId"
WHERE NOT EXISTS (
  SELECT 1 FROM "Card" c
  WHERE c."placeId" = p.id AND c.status <> '\''RETIRED'\''
)
ORDER BY p."createdAt" DESC, p.name;'
```

检查重名；期望返回 0 行：

```sh
docker compose -f compose.prod.yml --env-file .env.production exec -T db \
  psql -U zhixing -d zhixing -P pager=off -c '
SELECT name, COUNT(*)
FROM "Place"
GROUP BY name
HAVING COUNT(*) > 1;'
```

记录零卡总数，并明确本次是补所有层级，还是只补筛选后的地点。

## 三、补卡前备份

运行完整备份脚本。它会同时备份 PostgreSQL、MinIO 数据卷和不含密钥的恢复辅助配置，
详情见 [`backup-restore.md`](./backup-restore.md)：

```sh
scripts/backup.sh
```

脚本只有在数据库和 MinIO 都生成并通过校验后，才输出最终 `full-*` 目录。再次验证最近一份：

```sh
ZX_LATEST_BACKUP=$(find backups -maxdepth 1 -type d -name 'full-*' | sort | tail -n 1)
(cd "$ZX_LATEST_BACKUP" && sha256sum -c SHA256SUMS)
docker compose -f compose.prod.yml --env-file .env.production exec -T db \
  pg_restore --list < "$ZX_LATEST_BACKUP/database.dump" > /dev/null
tar -tzf "$ZX_LATEST_BACKUP/minio-volume.tar.gz" > /dev/null
```

如果任一步失败，不得开始生成。同机备份不能防 VPS 整机损坏；日常灾备还必须同步到
独立的异地存储。

## 四、生成

给全部零卡地点补到 1 张：

```bash
(
  set -e
  ZX_LLM_ENV_FILE="$(mktemp)"
  trap 'rm -f -- "$ZX_LLM_ENV_FILE"' EXIT
  awk '/^(GEMINI_API_KEY|DEEPSEEK_API_KEY|ZHIXING_LLM_PROVIDER|ZHIXING_GEN_MODEL)=/' \
    .env > "$ZX_LLM_ENV_FILE"
  chmod 600 "$ZX_LLM_ENV_FILE"
  test -s "$ZX_LLM_ENV_FILE"

  docker compose -f compose.prod.yml --env-file .env.production \
    run --rm --no-deps --env-from-file "$ZX_LLM_ENV_FILE" api \
    pnpm --filter @zhixing/pipeline batch -- --fill 1 --delay 4000
)
```

参数说明：

- `--fill 1`：每个地点至少保留 1 张未下架卡。
- `--delay 4000`：地点之间等待 4 秒，降低 LLM 限流风险。
- 临时 env 文件只包含 `GEMINI_API_KEY`、`DEEPSEEK_API_KEY`、`ZHIXING_LLM_PROVIDER`、
  `ZHIXING_GEN_MODEL` 中实际配置的项，权限为 `0600`，命令成功或失败后都会删除。
- `.env` 中的 `DATABASE_URL`、开发认证和其他配置不会进入一次性容器；生产数据库连接继续
  使用 `compose.prod.yml` 从 `.env.production` 组装的值。
- `--rm --no-deps`：结束后清理一次性容器，不重建常驻生产服务。

长任务可放进现有 tmux 会话执行。正常输出先显示计划数量，随后逐条显示
`✓ [分类] 地点：标题 (cardId)`，最后显示成功/失败汇总。只有汇总为“失败 0”时命令
才会成功退出；只要有一项失败，batch 会在处理完其余任务后返回非零状态。

生成失败不会回滚已成功项目。任务结束后直接原样重跑即可；batch 会重新统计，自动跳过
已有有效卡的地点。

## 五、执行后验收

### 1. 数据库验收

```sh
docker compose -f compose.prod.yml --env-file .env.production exec -T db \
  psql -U zhixing -d zhixing -P pager=off -c '
WITH place_cards AS (
  SELECT p.id,
         COUNT(c.id) FILTER (WHERE c.status <> '\''RETIRED'\'') AS active_cards
  FROM "Place" p
  LEFT JOIN "Card" c ON c."placeId" = p.id
  GROUP BY p.id
)
SELECT COUNT(*) AS places_total,
       COUNT(*) FILTER (WHERE active_cards > 0) AS places_visible,
       COUNT(*) FILTER (WHERE active_cards = 0) AS places_without_active_cards
FROM place_cards;'
```

全库补卡场景下，期望 `places_without_active_cards = 0`。

再检查卡片状态：

```sh
docker compose -f compose.prod.yml --env-file .env.production exec -T db \
  psql -U zhixing -d zhixing -P pager=off \
  -c 'SELECT status, COUNT(*) FROM "Card" GROUP BY status ORDER BY status;'
```

### 2. 公网 API 验收

```sh
node -e '
const response = await fetch("https://api.example.com/places/pins");
if (!response.ok) throw new Error(String(response.status));
const pins = await response.json();
console.log({
  total: pins.length,
  visible: pins.filter((pin) => pin.cardCount > 0).length,
  hidden: pins.filter((pin) => pin.cardCount === 0).length,
});'
```

全库补卡场景下，期望 `hidden: 0`。随后再次检查健康接口和 Compose 服务状态。

iOS 的 `PinsCache` 会缓存地点列表；已经打开 App 的测试者需要完全退出并重新打开，
才能立即看到新地图点。

## 六、内容复核与异常处理

- 新卡状态为 `AI_GENERATED`，生成完成后在管理后台“风物卡”页抽查内容和来源。
- 合格卡标记为已复核；不合格卡下架后，下一次 batch 会把该地点重新视为缺卡。
- 优先通过后台下架问题卡，不要直接删除生产数据。
- 补卡前备份用于灾难恢复，不应在生产已有新用户数据后直接整库覆盖；确需恢复时，先停止写入、
  评估备份时间点后的用户数据，再制定定向恢复方案。
- `node:22-slim` 中 Prisma 可能打印 OpenSSL 自动探测警告；只要实际数据库查询、写入和最终验收
  均成功，该警告不代表本次补卡失败。镜像依赖修正应作为独立代码任务处理。

## 七、下次交给 Codex 的指令模板

> 按 `docs/production-card-backfill-sop.md` 检查生产环境，统计所有零卡地点。确认范围后先备份，
> 使用 `.env` 中所选 provider 的 LLM Key 和 `ZHIXING_GEN_MODEL` 给所有零卡地点补到 1 张，持续监控到完成，
> 最后验证数据库、公网 `/places/pins` 和服务健康状态。不要输出密钥，不要触碰无关工作区修改。
