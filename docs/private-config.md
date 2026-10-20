# 私人配置与公开仓库

仓库只保留通用配置和示例地址。真实服务域名、发件人、密钥、本机路径和私人运维笔记保存在本地配置中，不提交到 Git。

## 本地保存位置

| 内容 | 位置 |
| --- | --- |
| API / 内容管线密钥与本地发件人 | 根目录 `.env` |
| 服务器域名、生产密钥、实际发件人 | 根目录 `.env.production` |
| 管理后台本地地图 Key | `apps/admin/.env.local` |
| Mac / iOS 发布 API 地址、签名 Team | `apps/ios/Config/Release.local.xcconfig` |
| 私人部署清单、历史清理备份 | `.private/` |

以上路径均被 Git 忽略；私人笔记也被 Docker 构建上下文排除。不要强制添加这些文件。已有的被跟踪文件即使加进 `.gitignore`，也仍会进入提交；删除最新版本同样不能清除旧历史。

## Mac / iOS 发布配置

```sh
cp apps/ios/Config/Release.local.xcconfig.example apps/ios/Config/Release.local.xcconfig
```

编辑本地文件中的 API 地址；xcconfig 会把 `//` 当成注释，因此保留示例的 `https:/$()/` 写法，Xcode 展开后才是正常 HTTPS 地址。需要真机签名时，在同一文件填写 `DEVELOPMENT_TEAM`。

然后照常运行 `xcodegen generate`、`scripts/mac-dmg.sh` 或 Xcode Archive。Release 未配置 HTTPS 地址，或者仍使用模板地址时，构建会报错；Debug 继续连接本机 API。

自动化构建也可以直接给 `xcodebuild` 传 `APP_API_BASE` 构建参数，无需在仓库中写入实际地址。不要把密钥放进此参数：API 地址最终会随 App 分发，客户端地址本身不应被当作认证防线。

## 服务端发件人

真实发信时，在 `.env` 或服务器的 `.env.production` 中显式设置 `MAIL_FROM`，使用邮件服务商已验证的域名。源码默认地址仅供本地控制台模式；生产 Compose 要求填写此变量。

## Git 身份与历史

使用 GitHub 提供的 noreply 邮箱作为此仓库的提交邮箱。改配置只影响新提交；旧邮箱、旧域名和被删文档须单独清理历史。

清理历史会改变提交 SHA。先保留私有 Git bundle 备份，在隔离副本中复扫所有分支、标签和提交信息，再替换远端历史。旧克隆不得把原有分支或标签推回，否则会重新带入已清理的内容。
