# 多平台扩展预研:安卓 / macOS / Web(2026-07-08 ~ 07-09)

> 状态:评估阶段,均未立项。本文是多平台方案讨论的输入材料,结论均为初步判断,待正式设计评审时裁决。
> 背景:iOS 端 M0+M1+M2 已完成(tag `m2-ios`,38 个 Swift 文件约 3900 行,76 测试);后端(api/admin/pipeline/db)与客户端完全解耦,所有平台共用同一套 REST API。

## 〇、四平台总览(先定目标,平台随目标自动出答案)

| 平台 | 解决的问题 | 成本 | 硬前置 |
|---|---|---|---|
| **macOS(Catalyst)** | 最便宜的第二平台;自用/大屏走查即刻可做 | 极低(几天,代码复用非重写) | 公开分发需 Apple 会员;自用零前置 |
| **Web 第一刀:公开展示层** | 补全分享闭环(长图二维码的落地页)+ SEO;杠杆最高 | 小(M2 公开端点+脱敏 DTO 现成,免登录) | 无(域名已备) |
| **安卓(Google Play)** | 触达海外新用户 | 重(~0.7–0.8× iOS,整体重写) | Play 账号确认;登录改造 |
| **Web 第二刀:全功能 Web App** | 墙内触达的替代方案(绕开 GMS/国内商店) | 中(~0.5–0.7× iOS 的 UI 层) | 墙内可用的登录(微信)与服务器选址 |

四者不互斥,是不同目标下的不同工具。方案讨论建议从"目标优先级"谈起。

---

# 第一部分:安卓版(Google Play)

## 一、已定的前提(用户决策)

1. **发行渠道:Google Play 优先**。用户已有 Google 开发者账号。
   - ⚠️ 待确认:账号是个人还是组织。2023-11 后注册的个人账号有硬性门槛——正式发布前需封闭测试(≥12 名测试者连续 14 天)。直接影响排期,应尽早去 Play Console 确认。
2. **v1 照片策略:只上 Photo Picker,批量导入(READ_MEDIA_IMAGES)延后到后续版本**。理由见第四节。

## 二、渠道决策的连锁推论

- **GMS(Google Mobile Services)= Play 商店 + Play Services(谷歌登录/Google Maps SDK/FCM 的运行时依赖)+ 全家桶**,需厂商向谷歌授权预装。国内销售的安卓机(国行小米/OV、全部华为)出厂不带 GMS,装不上 Play 商店。
- 因此 **Play 渠道用户 ≈ 海外购机用户**(留学生/华侨/外国人/水货或国际版 ROM 用户)。这是产品定位,不是缺陷,但要想清楚再动工。
- **待决策:目标用户在墙内还是墙外**。决定两件事:
  - 地图瓦片源在大陆的可达性(Mapbox/OSM 瓦片服务器在大陆不稳定);
  - API 服务器选址(example.com 的 VPS 部署在大陆则海外访问慢,反之亦然)。

## 三、登录改造(唯一需要动服务端的地方)

- 现状:auth 只认 Apple identityToken(`apps/api/src/apple.ts` 验 Apple JWKS → 换自签 HS256 session JWT)。
- 方案:新增 **Google Sign-In**。Apple/Google 的登录 token 都是标准 OIDC ID Token(JWT + 公开 JWKS),服务端可对称复刻:新建 `google.ts`,变的只是 issuer/JWKS URL/audience;session 发放流程共用。测试沿用 `fakeAppleToken` 的本地假密钥对思路。
- schema:建议**身份表独立于 User**(一个 User 挂多个身份),而不是在 User 上继续加 `googleSub` 列——为将来"同一人 iPhone(Apple 登录)+ 安卓(Google 登录)"的账号绑定/合并留余地。绑定功能本身不挡首发,但表结构要一步到位。若 Web 第二刀要加微信登录,同样受益于这次重构——**身份表独立化做一次,全平台受益**。
- 注意:Google Sign-In 客户端依赖 Play Services;若将来要覆盖无 GMS 设备,需换标准 OAuth 网页流。服务端只验 token,不受影响。

## 四、照片与权限(安卓预研信息量最大的部分)

### 4.1 安卓访问相册的两条路

| | Photo Picker | READ_MEDIA_IMAGES(宽泛权限) |
|---|---|---|
| 应用能看到什么 | 只有用户勾选的几张 | 遍历整个相册数据库 |
| 权限弹窗 | 无 | 有 |
| Play 专项声明审查 | 无 | 有(只批"核心功能依赖全库访问"的应用) |
| iOS 对应物 | PHPicker(撰写器在用) | PHPhotoLibrary 完整访问(AlbumImporter 在用) |

### 4.2 关键平台差异:安卓 Photo Picker 剥除 GPS(与 iOS 相反)

- iOS PHPicker 选出的照片**保留**位置元数据;**安卓 Photo Picker 自 Android 13 起默认剥除 GPS**(隐私设计)。2026 年谷歌开始给 Picker 加"是否附带位置"开关,但默认关、逐次确认,**不能作为产品依赖**。
- `ACCESS_MEDIA_LOCATION` 只对 MediaStore 直读生效,而 MediaStore 直读又需要 READ_MEDIA_IMAGES——**"免宽泛权限 + 读照片 GPS"的中间态在安卓上不存在**。
- 推论:"让用户从 Picker 手动多选旅行照片、应用读 EXIF 自动聚类"这条降级路**走不通**,批量导入天生就是双权限功能。

### 4.3 批量导入(延后功能)的完整技术形态

- 三件套:`READ_MEDIA_IMAGES`(遍历)+ `ACCESS_MEDIA_LOCATION`(解锁未脱敏位置,与前者一起运行时请求、通常不单独弹窗)+ 代码中逐 URI `setRequireOriginal` 再解析 EXIF。
- **性能坑**:iOS 的 `PHAsset.location` 是照片库预建索引,一次查询扫全库;安卓 MediaStore 的经纬度列自 Android 10 起废弃恒空,**必须逐张打开原始文件解析 EXIF 头**(ExifInterface)。几千张 = 几千次文件 I/O,且未缓存的云端照片可能触发下载。iOS 端已有的后台化/协作式取消/进度反馈在安卓是必需品,还需追加**增量扫描缓存**(记录已扫照片 ID),iOS 因查询快而没做。
- **Play 声明表写法要点**:论证核心是"为什么 Photo Picker 不行"——应用需读全库照片 EXIF 地理标签自动聚类生成旅行足迹,用户无法预知哪些照片含位置信息,故无法手动选择。配功能演示视频。批量导入与"照片备份类"访问模式同构,属政策明文允许类别,有正当获批基础。写成"导入照片"这种含糊表述大概率被打回。
- 需处理 Android 14 "部分照片访问"(partial access)状态,对应 iOS 的 `.limited`。

### 4.4 对功能本质的澄清(纠正过的一个误解)

批量导入**不是全量导入**:iOS 实现(`AlbumImporter.swift`)是 EXIF 有 GPS 的才收集 → 匹配到 pin 的才聚类(48h 间隔拆段)→ 用户在 review 界面逐组勾选 → 每段上限 9 张。"扫描全库"是筛选手段,不是导入范围——正因为用户照片多且大部分与旅游无关,人工挑不动,才需要机器筛。延后它的正当理由是**审查风险 + v1 范围收敛 + 安卓实现成本高一档**,而非功能本身有问题。

### 4.5 v1 设计后果

- 发足迹配图:Photo Picker 多选(反正 GPS 已被剥,上传前重编码与否语义一致;iOS 端本就剥 EXIF 再传)。
- 足迹选点:**只做**当前位置一键选点(对应 iOS LocationOnce)+ 搜索选点;不设计任何"从照片读位置"的交互。
- **首启体验需重新设计**:iOS 冷启动靠批量导入瞬间点亮地图(aha 时刻),安卓 v1 没有,第一屏是空地图,需替代引导(如"点亮第一个足迹"任务流),否则留存难看。

## 五、地图选型

- 不用高德(面向国内合规体系,海外分发不友好);不用 Google Maps SDK(把应用焊死在 GMS 上,且大陆瓦片不可达)。
- 倾向 **MapLibre**(开源免费、不依赖 Play Services、自带瓦片源可换)或 Mapbox。与 Web 端的 MapLibre GL JS 同族,样式/瓦片源配置可跨端共享。
- 坐标系红利:MapLibre/Mapbox/OSM 瓦片都是 WGS-84,与 EXIF GPS 同系,**无需 GCJ-02 纠偏**;服务端继续统一存 WGS-84。(若将来出国内商店版换高德,渲染层才需要 WGS-84→GCJ-02 转换,数据层不动。)

## 六、技术栈与工作量

- 建议 **Kotlin + Jetpack Compose 纯原生**,iOS 端已打 tag 不动。反对 KMP(要重写已验收的 iOS Core,4000 行体量得不偿失)、反对 Flutter/RN(两端推倒)。
- 平台 API 映射:SwiftUI+Observation→Compose+ViewModel/Flow;MapKit→MapLibre;PhotosUI→Photo Picker;Keychain→Keystore/EncryptedSharedPreferences;CoreLocation→FusedLocationProvider(注意它也依赖 Play Services);AuthenticationServices→Google Sign-In。
- 工程基建:monorepo 加 `apps/android`(Gradle 承担 project.yml 的角色);对照 14 个 iOS 测试文件写 JUnit/Robolectric;`scripts/android-test.sh`;签名打包。
- 粗估:**约 iOS 已投入工作量的 0.7–0.8 倍**(设计已定型,照图施工;v1 砍掉批量导入后可能更低)。

## 七、合规清单(Play 渠道,大幅轻于国内商店)

- 需要:隐私政策 URL(挂 example.com)+ Data Safety 表单 + target API level 跟进 + (个人账号)封测门槛。
- 不需要:软件著作权、App ICP 备案、国内商店隐私整改。
- 延后到批量导入版本:READ_MEDIA_IMAGES 声明审查(届时已有上架应用和演示视频,论证地位更好)。

---

# 第二部分:macOS 桌面版

## 一、路线:Mac Catalyst(推荐),代码复用而非重写

- 三条路对比:**Catalyst**(iOS 工程直接编译为 Mac 应用,推荐)/ "Designed for iPad"(零改动但仅限 Mac App Store,做不成 dmg,略过)/ 原生 macOS target(UIImage→NSImage 等适配,成本高收益有限,不值)。
- 现有代码的 iOS 独有依赖极少:仅 6 个文件碰 UIKit/UIImage,而 **Catalyst 环境下 UIKit 原生可用,一行不用改**;MapKit/PhotosUI/CoreLocation/AuthenticationServices/Keychain 全部支持。
- 改动点:`project.yml` 加 Catalyst 目标(xcodegen `supportedDestinations`)+ 桌面体验适配(窗口尺寸、悬停态、菜单栏、宽屏侧栏布局——SwiftUI NavigationSplitView 两端自适应)。**量级:几天**。

## 二、dmg 分发与签名链

- dmg 本身 `hdiutil`/`create-dmg` 即可;真正门槛是门禁链:**Developer ID 证书签名 → notarytool 公证 → 装订票据**。需要 Apple Developer Program 会员($99/年)——与 iOS TestFlight 是同一张会员卡,办一次两平台都通。
- **无公证分发的现实**(用户确认过想走这条路的可行性):
  - 能装,但 macOS 15 Sequoia 起取消了"右键→打开"绕过,放行流程变为:双击被拦 → 系统设置→隐私与安全性→"仍要打开"→ 密码确认(四步);或终端删 quarantine 属性。
  - Apple Silicon 要求至少 ad-hoc 签名才能启动——Xcode 构建自动完成,无需证书。
  - **结论:自用/小圈子内测 ✅;公开挂网下载 ❌**(每个用户四步放行 + "无法验证不含恶意软件"弹窗,信任成本过高,且苹果在持续收紧这条缝隙)。
- **隐藏卡点**:Sign in with Apple 的 entitlement 不对免费开发者账号开放——无会员的自用构建里 SIWA 签不进去,需走 dev auth(`ZHIXING_DEV_AUTH=1`,绝不能开在生产)。另外 Developer ID(店外分发)应用的原生 SIWA 历史上有坑,备选是 `ASWebAuthenticationSession` 网页流——服务端只验 identityToken,不受影响。

## 三、产品角度的独特价值

- **Mac 恰恰是批量导入的最佳平台**:全量照片归档多在 Mac 照片库(iPhone 常只有优化副本),Catalyst 下 PHPhotoLibrary 读的就是 Mac 本机照片库,且 dmg 分发**没有任何商店权限审查**。"大屏看地图 + 全量相册扫描"比手机更贴合"回顾我去过哪儿"。
- **即刻可做的事**:会员未办的当下,Catalyst + ad-hoc 签名 dmg 即可出"自用 Mac 版"(登录走 dev auth),用于大屏走查 M2 地图交互、用 Mac 照片库实测批量导入;会员办下后同一构建加签名公证就地升级为可公开分发版,前期零浪费。

---

# 第三部分:Web 版

## 一、切成两刀,别一次做全

| 切法 | 内容 | 成本 | 价值 |
|---|---|---|---|
| **第一刀:公开展示层** | 足迹/旅程/风物卡只读页,作分享长图二维码的落地页 + SEO 入口 | 小(M2 公开端点 `routes/public.ts` + 脱敏 DTO 现成,**免登录**) | 高——补全"看长图→扫码→浏览器浏览→引导装 App"的分享裂变闭环,是现有功能的缺失一环 |
| **第二刀:全功能 Web App** | 登录、地图浏览、发足迹、批量导入 | 中(~0.5–0.7× iOS 的 UI 层,React/TS 重写) | 视定位——主打墙内触达则高,否则与原生重复 |

## 二、Web 的先天优势

- **分发零门槛**:无商店、无审核、无会员、即时更新、链接即达。
- **国内安卓用户的唯一触达方式**:绕开 GMS/Play 死结,微信内点开链接即用(比国内商店上架的软著+ICP 路线便宜得多)。
- **批量导入无权限审查**:浏览器选文件/拖拽文件夹,前端 JS 解析 EXIF GPS(exifr 类库),聚类逻辑照搬。桌面浏览器场景尤其顺(照片归档在电脑文件夹)。⚠️ 移动浏览器上传照片的 EXIF GPS 保留情况因系统而异(iOS Safari 有剥除行为),立项时需实测;桌面场景已足够立住功能。
- **技术栈有先例**:apps/admin 就是"Next.js + 纯客户端 fetch 打 API"的完整样板,新增 `apps/web` 同构复制(monorepo/API client/CORS/部署路径均有现成答案)。地图用 **MapLibre GL JS**,与安卓选型同族。

## 三、Web 的短板

- **登录**:SIWA 网页版需注册 Services ID(要 Apple 会员);Google 网页 OAuth 免费但墙内不可用;覆盖微信内用户最终绕不开微信登录(服务端加 provider,与身份表独立化重构是同一件事)。
- **体验上限**:移动浏览器地图交互比原生糙一档;无可靠推送;iOS 上 PWA 存在感弱。Web 适合"看和轻交互",重度记录场景原生强。
- 若主要服务墙内用户:服务器选址与域名 ICP 备案问题与安卓预研第二节共享同一个待决策。

## 四、架构复利备注

M0 把"公开读走独立端点 + 脱敏 DTO"物理隔离的决定,使 Web 第一刀几乎零成本——公开页只碰 public.ts,连登录都不用做。当初为隐私做的设计,买到了多平台扩展的期权。

---

# 立项前待用户确认/决策清单

0. **目标优先级**(总开关,决定平台顺序):自用大屏走查?补分享闭环?海外新用户?墙内触达?
1. Play 开发者账号类型(个人/组织)及有无 Production access 限制;
2. 目标用户墙内还是墙外(决定瓦片源、服务器选址、Web 登录方案);
3. 账号体系:身份表重构(独立于 User 的多身份表)是否随首个新平台登录改造一并做(建议是,安卓/Web/Mac 店外版全受益);
4. 安卓 v1 首启引导方案(替代批量导入 aha 流的空地图问题);
5. 技术栈终审(安卓纯原生 vs 其他;Web 是否复用 Next.js);
6. Apple Developer Program 办理时点(同时解锁:iOS TestFlight/真机 SIWA、Mac 公开分发、SIWA 网页版 Services ID)。
