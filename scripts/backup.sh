#!/usr/bin/env bash
# 每日数据库备份，保留 14 天。VPS 上 crontab: 0 4 * * * /path/to/repo/scripts/backup.sh
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p backups
docker compose -f compose.prod.yml exec -T db pg_dump -U zhixing zhixing | gzip \
  > "backups/zhixing-$(date +%Y%m%d-%H%M).sql.gz"
ls -t backups/zhixing-*.sql.gz | tail -n +15 | xargs -r rm
