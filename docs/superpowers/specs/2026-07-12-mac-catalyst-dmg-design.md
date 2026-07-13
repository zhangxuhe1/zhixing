# Mac 桌面版（Catalyst）+ dmg 分发设计（2026-07-12）

> 目标：把知行 iOS App 构建为 Mac 桌面版，打包成 dmg 分发给朋友小圈子体验。
> 前置结论来自多平台预研（2026-07-08-multiplatform-pre-research.md 第二部分）：路线定为 Mac Catalyst（代码复用非重写）。
> 用户已决策：暂不办 Apple Developer 会员（走 ad-hoc 签名 + 安装说明）；VPS 尚未部署（部署纳入前置，与客户端开发并行）；首版桌面适配只做最小可用，桌面级体验（侧栏/悬停/菜单栏）另立后续计划。

## 范围总览

四块工作，客户端三块（本计划主体）与 VPS 部署（走既有 runbook，用户主导）并行：

1. 邮箱验证码登录 UI（客户端，iOS/Mac 共用）
2. Catalyst 工程改造 + 最小桌面适配
3. dmg 打包脚本 + 面向朋友的安装说明
4. VPS 部署配合（含部署前硬化清单代码项）+ 端到端验收

关键约束：无 Apple 会员 → Sign in with Apple 的 entitlement 无法签进 ad-hoc 构建 → **Mac 版唯一正规登录路径是邮箱验证码**（服务端 OTP 已完成，客户端 UI 是本计划必做项）。

## 一、邮箱验证码登录 UI

**流程**：`SignInScreen` 增加"邮箱验证码登录"区块，两步交互——

1. 输入邮箱 → 点"发送验证码" → `POST /auth/email/send`，按钮进入冷却倒计时——send 成功仅返回 `{ok:true}`、**不下发冷却秒数**，客户端自带倒计时常量（取值与服务端 `EMAIL_CODE.cooldownMs` 一致，当前 60s，注释互指，改参数时两边同步）；
2. 输入 6 位验证码 → `POST /auth/email/verify` → 拿到 session JWT，走与 SIWA 完全相同的 `SessionStore` 存储路径（Keychain），后续请求无差别。

**平台差异**：

- Mac（Catalyst）上用 `#if targetEnvironment(macCatalyst)` 编译期裁掉 SIWA 按钮（ad-hoc 构建签不进 applesignin entitlement，按钮留着只会报错）；Mac 版登录 = 邮箱验证码唯一入口。
- iOS 上两种登录并存（邮箱登录对 iOS 也是净收益：真机不依赖 Apple 账号即可测试）。
- "开发登录"按钮维持现状（仅 DEBUG 构建可见，且需服务端开 dev auth）。

**错误呈现**：服务端**故意合并**错误面（防爆破设计，见 emailAuth.ts / routes/auth.ts 注释，勿为 UI 拆开）：冷却/日限统一 429 `rate_limited`、错码/过期/尝试锁死统一 401 `invalid_code`，均不带细分信息。客户端**按 HTTP status 映射**中文提示、不解析 body 字符串（authRateLimit 插件的 429 体形与 `{error}` 不同——按 status 判别对两种体形都稳）：

- 429 →"操作太频繁，请稍后再试"（冷却或日限，服务端不区分、无剩余秒数）；
- 401 →"验证码错误或已失效，请重新获取"（错码/过期/锁死，服务端不区分）；
- 其余（含 400）→ 笼统失败提示；邮箱格式/6 位数字由客户端本地校验提前兜住。

**代码位置**：`Auth/` 下新增 `EmailSignInSection.swift`（SignInScreen 只负责组装）+ `APIClient` 增加两个端点方法 + 单元测试（验证码输入校验、倒计时状态机）。

## 二、Catalyst 工程改造 + 最小桌面适配

**project.yml 改动**（唯一工程真源，改完 `xcodegen generate`）：

- Zhixing target 加 `supportedDestinations: [iOS, macCatalyst]`；
- **entitlements 按平台分叉**（关键）：现有 `Zhixing.entitlements` 含 `com.apple.developer.applesignin`，ad-hoc 签名带着它 Mac 构建直接失败。用条件构建设置 `CODE_SIGN_ENTITLEMENTS[sdk=macosx*]` 指向新增的 `ZhixingMac.entitlements`（不含 SIWA，但必须包含 `com.apple.security.personal-information.photos-library`，否则 TCC 即使显示已授权也会拒绝访问 Mac 照片库；Catalyst 构建走 macosx SDK，条件精确命中），iOS 构建不受影响；
- 补 `MARKETING_VERSION: 0.1.0`，**并同步**在 `info.properties` 补 `CFBundleShortVersionString: $(MARKETING_VERSION)`——XcodeGen 生成的 Info.plist 把版本号硬编码为 1.0，只加构建设置流不进产物（探针已实证），dmg 产物命名依赖真实版本号。

**最小桌面适配**（只做三件事）：

1. 窗口最小尺寸：`UIWindowScene.sizeRestrictions` 设最小 1000×700，避免窗口拖成手机条状导致地图不可用；
2. 核心流程走查修复：邮箱登录 → 退出重开 App 验证登录态仍在（钥匙串在 Catalyst 上的首个真实读写路径）→ 地图浏览/风物卡 → 发足迹（搜索/当前位置选点）→ 批量导入（Mac 照片库，本版核心卖点）→ 我的页。只修阻断性问题（崩溃、点不到、功能不可用），观感问题记录后留给后续"桌面级体验"计划；
3. 已知风险点预检：CoreLocation 在 Mac 首次定位授权弹窗行为不同；PHPhotoLibrary 读的是 Mac「照片」App 图库（未开 iCloud 照片的用户图库可能为空——安装说明提示）；钥匙串跨版本：ad-hoc 签名的 designated requirement 绑二进制 hash、逐版本变化——首装首登正常，**升级新版后**旧 token 条目会触发系统钥匙串授权弹窗或读不到（表现为升级即登出），v0.1 单版本无感，写进安装说明做预期管理；现有 Keychain.swift 不用 data-protection keychain 的写法在 ad-hoc 下是唯一可行解（改用会 -34018 缺 application-identifier），勿动。

**测试不动**：ZhixingTests 继续跑 iOS 模拟器（scripts/ios-test.sh 原样）；Catalyst 侧保障 = dmg 脚本 Release 构建成功 + 人工走查，首版不为 Mac 单独建测试 target。

## 三、dmg 打包脚本 + 安装说明

**脚本 `scripts/mac-dmg.sh`**（对齐 scripts/ios-test.sh 风格）：

1. `xcodegen generate` → `xcodebuild` 以 `destination 'generic/platform=macOS,variant=Mac Catalyst'` + Release 配置构建（`APP_API_BASE` 取 release 档 `https://api.example.com`），ad-hoc 签名需**同时覆写** `CODE_SIGN_STYLE=Manual` + `CODE_SIGN_IDENTITY="-"`——工程默认 Automatic 且无 Team，不覆写会先死在"缺 development team"、到不了 ad-hoc（ad-hoc 是 Apple Silicon 启动的最低要求，无需证书）；
2. `hdiutil` 生成 dmg：构建产物默认名为 `Zhixing.app`，装盘前重命名为 `知行.app`（重命名不破坏签名；安装说明里的路径/xattr 命令与之对齐），卷内含 `知行.app` + `/Applications` 快捷方式（拖拽安装布局），产物命名 `Zhixing-<版本号>.dmg`；
3. 升级钩子：脚本检测环境变量 `MAC_SIGN_IDENTITY`，设了就走 Developer ID 签名 + `notarytool` 公证 + 装订，没设就 ad-hoc——将来办会员后零改动升级为可公开分发版。

**安装说明 `docs/mac-install.md`**（直接发给朋友的中文文档）：

- 系统要求：macOS 14 Sonoma+（iOS 17 部署目标对应的 Catalyst 版本），Apple Silicon 或 Intel；
- 安装：打开 dmg，拖进"应用程序"；
- 首次打开放行（重点，逐步描述；**最终文案以验收第 1 步干净环境实测为准**）：ad-hoc 构建 + quarantine 在 Apple Silicon 上大概率弹「"知行"已损坏，无法打开」——该对话框**没有**"仍要打开"通道，主路径是终端一行 `xattr -dr com.apple.quarantine /Applications/知行.app`；若实测弹的是"无法验证开发者"类对话框（Intel 机器可能如此），备路径才是 系统设置 → 隐私与安全性 → 拉到底点"仍要打开" → 输密码。说明原因（未做 Apple 公证的个人开发内测版），只需操作一次；
- 零门槛备选分发：quarantine 只在浏览器/网盘/AirDrop 等下载途径被打上，**U 盘 / scp 拷贝的 dmg 没有这道关卡**——小圈子分发优先走这条路可完全绕开放行步骤，文档写明；
- 使用提示：邮箱验证码注册登录；批量导入读取 Mac「照片」App 图库，建议开启 iCloud 照片同步后体验（刚开启后同步很慢，可能要等较久才有图，提前管理预期）；升级新版本后若弹系统钥匙串授权框或被登出，属预期行为（ad-hoc 签名逐版本变化所致），重新登录即可。

## 四、VPS 部署配合 + 端到端验收

**部署主体走 docs/deploy.md**。用户负责只能本人做的三件事：VPS 采购、DNS 三条 A 记录（api / admin / s3）、SMTP 发信账号（含 SPF/DKIM，否则验证码邮件进垃圾箱）。

**部署前硬化清单代码项纳入本计划**（deploy.md 标注"首次部署时执行"）：

1. 启动断言：SESSION_SECRET / ADMIN_TOKEN / S3_SECRET_KEY 为默认值或空串时 api 拒绝启动；
2. compose 健康检查：db/minio 加 healthcheck，api `depends_on.condition: service_healthy`，防首启 migrate 竞态；
3. 统一错误形状：setErrorHandler 把框架级 404/413/500 收敛到 `{error:"..."}`；
4. 备份含 MinIO 卷（VPS 上 crontab 操作，写进部署核对项）。

环境变量核对：`TRUST_PROXY=1`（Caddy 反代后必开）；`ZHIXING_DEV_AUTH` 绝不设置；`SMTP_URL` / `MAIL_FROM` 配好。

**内容数据**：按 runbook 步骤 5 推荐路径，本地生成复核后 `pg_dump` 整库上传、TRUNCATE 测试用户数据——朋友打开地图第一眼要有风物卡内容。

**端到端验收（模拟朋友视角，最后一关）**：

1. 干净环境（另一台 Mac 或本机新建用户账户）挂载 dmg → 拖装 → 按安装说明完成放行，**记录实际弹窗形态（"已损坏" 还是 "无法验证开发者"），据此定稿 mac-install.md 放行段落**；
2. 邮箱验证码真实送达（QQ / 163 / Gmail 各测一个，确认不进垃圾箱）→ 登录成功；
3. 地图有内容、风物卡可读、发足迹、Mac 照片库批量导入全流程可用；
4. admin 控制台能看到新用户与足迹数据。

验收全过 → dmg 发朋友。

## 非目标（后续计划）

- 桌面级体验：NavigationSplitView 宽屏侧栏、悬停态、菜单栏快捷键——另立计划；
- Developer ID 签名 + 公证的公开分发（等 Apple 会员，脚本已留钩子）；
- Mac 专属测试 target。
