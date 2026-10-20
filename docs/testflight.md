# TestFlight 内测发布 Runbook（M1）

## 前置（用户准备，无法代办）
1. Apple Developer Program 会员（¥688/年）——个人账号即可
2. 服务端已按 docs/deploy.md 部署，`https://api.<域名>/health` 可达
3. 确定正式 bundle id（如 com.<你的姓氏>.zhixing）——若换：
   - `apps/ios/project.yml` 的 PRODUCT_BUNDLE_IDENTIFIER
   - 服务器 `.env.production` 的 APPLE_BUNDLE_ID，重启 api

## 发布步骤
1. 把 `apps/ios/Config/Release.local.xcconfig.example` 复制为同目录下的
   `Release.local.xcconfig`，填写实际 API 地址及 DEVELOPMENT_TEAM（Team ID），
   然后在 `apps/ios` 运行 `xcodegen generate`。本地配置已被 Git 忽略；
   URL 按示例用 `https:/$()/` 写法，避免 `//` 被 xcconfig 当成注释。
2. Xcode 打开工程 → Signing & Capabilities 确认自动签名 + Sign in with Apple 能力无红字
3. App Store Connect（appstoreconnect.apple.com）→ 我的 App → 新建 App：
   平台 iOS、名称「知行」（若重名换备用名，见规格书 Q5）、bundle id 选上一步注册的、SKU 随意
4. Xcode：Product > Destination 选 Any iOS Device → Product > Archive
   → Organizer 里 Distribute App > TestFlight & App Store → 上传
5. App Store Connect > TestFlight：
   - 填写测试信息（Beta 版描述、反馈邮箱）
   - 出口合规：已在 Info.plist 声明 ITSAppUsesNonExemptEncryption=false，无需再答
   - 内部测试：把自己的 Apple ID 加进内部组，先真机自测
   - 外部测试：建「首批内测」组 → 加 10–30 位测试者邮箱 → 提交 Beta 审核（1–2 天）
6. 给测试者发 TestFlight 邀请 + 一段话引导：
   「装好后：① 用 Apple 登录 ② 点『从相册批量导入』看看这些年走过的地方
    ③ 随便逛逛地图上的风物卡。反馈直接 TestFlight 截图摇一摇，或拉群聊。」

## M1 过关标准（规格书 §7）
观察内测者是否**自发**导入相册并反复翻看自己的足迹地图（aha 验证）。
M1 无埋点，靠访谈 + 服务端翻 Footprint 表创建来源与时间分布判断。

## 真机自测清单（每次上传前过一遍）
- [ ] Apple 登录真机走通（模拟器 dev 旁路在 Release 构建不存在）
- [ ] 地图缩放流畅、聚合正常、随便走走能飞
- [ ] 留足迹带 2 张照片成功；「我的」里缩略图能加载
- [ ] 相册导入：授权→聚组→导入→我的地图点亮
- [ ] 飞行模式打开 App：不崩溃，能看到登录态与提示
