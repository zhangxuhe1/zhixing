# 生产数据备份与恢复

生产数据分布在两套持久化存储中：

- PostgreSQL：地点、风物卡、用户、身份、足迹、照片元数据、互动数据等。
- MinIO：用户上传的实际图片对象、桶元数据以及 MinIO 系统元数据。

只运行 `pg_dump` 不等于完整备份。`scripts/backup.sh` 会同时备份两套存储，并保存
不含密钥的恢复辅助配置。

## 一、备份内容

每次成功执行会生成 `backups/full-<UTC 时间>/`：

```text
database.dump
minio-volume.tar.gz
SHA256SUMS
config/
  compose.prod.yml
  Caddyfile              # 宿主存在时
  git-revision.txt
```

- `database.dump` 是 PostgreSQL custom-format 全库备份，可由 `pg_restore` 读取。
- `minio-volume.tar.gz` 是 `zhixing_minio-data` 的底层卷只读归档，包含 `.minio.sys`；它不是
  文件系统时间点快照，一致性限制见第五节。
- `SHA256SUMS` 覆盖备份内所有文件；脚本生成后立即执行校验。
- `.env`、`.env.production` 和其他密钥不会写入备份。灾备时可以轮换大多数密钥；
  必须长期保留的配置应存入独立密码管理器，不能只留在 VPS。
- Git 仓库和容器镜像不视为用户数据；源码由 GitHub 保存，配置中的 revision 用来定位
  恢复时应部署的版本。

脚本默认保留最新 14 份完整备份，可通过 `ZX_BACKUP_KEEP` 调整。

## 二、手工执行与验收

```sh
scripts/backup.sh
```

成功标志是最后输出 `完整备份完成：backups/full-...`。只有数据库和 MinIO 都生成且
通过校验后，目录才会从隐藏的 `.partial` 名称改为 `full-*`；中途失败时，本次 `.partial`
目录会自动清理。

复查最近一份备份：

```sh
ZX_LATEST_BACKUP=$(find backups -maxdepth 1 -type d -name 'full-*' | sort | tail -n 1)
(cd "$ZX_LATEST_BACKUP" && sha256sum -c SHA256SUMS)
docker compose -f compose.prod.yml --env-file .env.production exec -T db \
  pg_restore --list < "$ZX_LATEST_BACKUP/database.dump" > /dev/null
tar -tzf "$ZX_LATEST_BACKUP/minio-volume.tar.gz" > /dev/null
```

## 三、每日任务

root crontab：

```cron
0 20 * * * mkdir -p /root/idea/zhixing/backups && cd /root/idea/zhixing && /root/idea/zhixing/scripts/backup.sh >> /root/idea/zhixing/backups/backup.log 2>&1
```

服务器时区为 UTC，因此 `20:00 UTC` 对应北京时间次日凌晨 `04:00`。

至少每周检查一次日志、最近备份时间和 `SHA256SUMS`。仅配置 cron 而不监控失败，不能算
完成备份建设。

## 四、异地副本（必须）

`backups/` 与生产数据位于同一块 VPS 磁盘。同机备份只能处理误删除、错误发布和单个服务
损坏，无法处理整机丢失、磁盘损坏、云账号故障或勒索删除。

必须把每个完成的 `full-*` 目录自动复制到独立故障域，例如：

- 另一云厂商的私有 S3 / R2 / OSS bucket；
- 另一台服务器；
- 运维人员本地且有额外备份的加密磁盘。

异地存储应启用私有访问、对象版本或不可变保留策略，并使用仅允许写入备份前缀的独立凭据。
同步工具和凭据在确定目标后配置；不得把异地凭据提交进仓库。

建议目标：

- 本机完整归档：每日，保留 14 份。
- 异地完整快照：每日同步，至少保留 30 天。
- 恢复演练：每季度至少一次，在隔离环境验证数据库恢复、图片读取和 API 启动。

## 五、一致性说明

当前脚本先对 PostgreSQL 做事务一致的 `pg_dump`，再以只读方式归档 MinIO volume。
两套存储之间不是同一事务；只读挂载也不会把正在运行的 MinIO volume 变成原子快照。
如果归档期间恰好有对象写入或删除，底层对象与 `.minio.sys` 理论上可能落在不同时间点。
`SHA256SUMS` 和 `tar -tzf` 只验证归档传输与文件结构，不证明 MinIO 语义上可完整恢复。
在当前测试阶段、数据量和写入频率都很低时，接受这一限制作为低停机成本的临时折中。

正式生产化前必须重新评估并按 MinIO 社区最佳实践升级：根据部署条件选择维护窗口停止写入、
文件系统/云盘原子快照，或对象级 mirror / bucket replication，并补齐桶元数据导出、实际 MinIO
镜像版本记录和隔离环境恢复演练。不要让当前日常脚本未经评估就自动停止生产 API。

## 六、恢复原则

恢复是破坏性操作，不纳入日常备份脚本自动执行。发生事故时：

1. 先保护现存磁盘和日志，不在原数据卷上直接试错。
2. 在新服务器或隔离 volume 中部署 `git-revision.txt` 对应代码。
3. 校验 `SHA256SUMS`，再用 `pg_restore` 恢复 `database.dump`。
4. 在 MinIO 停止状态下，把 `minio-volume.tar.gz` 解到新的 `/data` volume。
5. 重新配置或轮换 `.env.production` 中的密钥，启动服务。
6. 对照数据库 `FootprintPhoto` 记录抽查对象可读性，再切换公网流量。

禁止在生产已有新用户数据时直接用旧备份整库覆盖。部分数据损坏应优先制定定向恢复方案。
