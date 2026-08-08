#!/usr/bin/env bash
# 每日完整备份：PostgreSQL + MinIO 数据卷 + 非敏感恢复配置，默认保留 14 份。
# VPS 使用 UTC 时区时：20:00 UTC = 北京时间次日 04:00。
# crontab: 0 20 * * * /path/to/repo/scripts/backup.sh
set -euo pipefail
umask 077

cd "$(dirname "$0")/.."
mkdir -p backups

ZX_BACKUP_KEEP="${ZX_BACKUP_KEEP:-14}"
if [[ ! "$ZX_BACKUP_KEEP" =~ ^[1-9][0-9]*$ ]]; then
  echo "ZX_BACKUP_KEEP 必须是正整数" >&2
  exit 1
fi

# 防止 cron 重叠执行；上一次尚未完成时，本次直接失败而不是争抢同一数据卷。
exec 9>backups/.full-backup.lock
if ! flock -n 9; then
  echo "已有完整备份正在运行" >&2
  exit 1
fi

ZX_BACKUP_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ZX_BACKUP_PARTIAL="backups/.full-${ZX_BACKUP_STAMP}.partial"
ZX_BACKUP_FINAL="backups/full-${ZX_BACKUP_STAMP}"
ZX_COMPOSE=(docker compose -f compose.prod.yml --env-file .env.production)

cleanup_partial() {
  if [[ -d "${ZX_BACKUP_PARTIAL:-}" && "$ZX_BACKUP_PARTIAL" == backups/.full-*.partial ]]; then
    echo "清理未完成备份：$ZX_BACKUP_PARTIAL" >&2
    rm -rf -- "$ZX_BACKUP_PARTIAL"
  fi
}
trap cleanup_partial EXIT

mkdir -p "$ZX_BACKUP_PARTIAL/config"

# 先做数据库的一致性快照，再归档 MinIO。两套存储之间不是同一事务；需要严格时间点一致性时，
# 应另开维护窗口暂停 API 写入后再运行本脚本。
"${ZX_COMPOSE[@]}" exec -T db \
  pg_dump -U zhixing -d zhixing -Fc > "$ZX_BACKUP_PARTIAL/database.dump"

ZX_MINIO_CONTAINER="$("${ZX_COMPOSE[@]}" ps -q minio)"
if [[ -z "$ZX_MINIO_CONTAINER" ]]; then
  echo "找不到正在运行的 MinIO 容器" >&2
  exit 1
fi

ZX_MINIO_VOLUME="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$ZX_MINIO_CONTAINER")"
if [[ -z "$ZX_MINIO_VOLUME" ]]; then
  echo "找不到 MinIO /data 对应的数据卷" >&2
  exit 1
fi

# 使用已部署且本机已有的 Alpine 镜像，以只读方式归档完整 MinIO volume；其中包含对象、
# 桶元数据和 .minio.sys，不依赖 S3 凭据，也不会把凭据写进备份。
docker run --rm \
  -v "$ZX_MINIO_VOLUME:/data:ro" \
  -v "$PWD/$ZX_BACKUP_PARTIAL:/backup" \
  postgres:16-alpine tar czf /backup/minio-volume.tar.gz -C /data .

cp compose.prod.yml "$ZX_BACKUP_PARTIAL/config/compose.prod.yml"
if [[ -f /etc/caddy/Caddyfile ]]; then
  cp /etc/caddy/Caddyfile "$ZX_BACKUP_PARTIAL/config/Caddyfile"
fi
git rev-parse HEAD > "$ZX_BACKUP_PARTIAL/config/git-revision.txt"

(
  cd "$ZX_BACKUP_PARTIAL"
  mapfile -t ZX_BACKUP_FILES < <(find . -type f ! -name SHA256SUMS -printf '%P\n' | sort)
  sha256sum "${ZX_BACKUP_FILES[@]}" > SHA256SUMS
  sha256sum -c SHA256SUMS
  tar -tzf minio-volume.tar.gz > /dev/null
)
"${ZX_COMPOSE[@]}" exec -T db pg_restore --list \
  < "$ZX_BACKUP_PARTIAL/database.dump" > /dev/null

# 只有全部生成和校验成功后，才从 .partial 原子改名为可恢复备份。
chmod -R go-rwx "$ZX_BACKUP_PARTIAL"
mv "$ZX_BACKUP_PARTIAL" "$ZX_BACKUP_FINAL"
trap - EXIT

mapfile -t ZX_EXPIRED_BACKUPS < <(
  find backups -maxdepth 1 -mindepth 1 -type d -name 'full-*' -printf '%T@ %p\n' \
    | sort -nr \
    | tail -n "+$((ZX_BACKUP_KEEP + 1))" \
    | cut -d' ' -f2-
)
for ZX_EXPIRED_BACKUP in "${ZX_EXPIRED_BACKUPS[@]}"; do
  rm -rf -- "$ZX_EXPIRED_BACKUP"
done

echo "完整备份完成：$ZX_BACKUP_FINAL"
echo "注意：同机备份不能防 VPS 整机损坏，必须再同步到独立的异地存储。"
