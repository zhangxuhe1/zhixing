# 知行 · 登录验证码邮件模板设计

> 状态：设计定稿，待实现
> 日期：2026-07-13
> 关联：`apps/api/src/mailer.ts`（渲染 + 发送）、`apps/api/src/emailAuth.ts`（调用方）、`apps/api/src/config.ts`（发件人默认值）

## 1. 背景与目标

知行现有一版可用的登录验证码邮件（`renderCodeEmail`），但为**单一用途硬编码**：无完整 HTML 文档骨架、无移动端自适应、品牌文案散落在字符串里、视觉是通用深灰调，与知行「风物 / 掌故 / 方言」的人文遗产气质不搭。

本设计借鉴同作者的 参考项目 项目邮件模板中**真正有价值的部分**，为知行重做一版**符合品牌气质**的登录验证码邮件——采用「混合式」改造范围（见 §2）。

参考对象 参考项目（`src/lib/mailer.ts`）的可借鉴点：完整 HTML 文档 + `viewport` 移动端自适应、品牌文案集中化、可复用样式常量、衬线体品牌字、页头标语、链接安全护栏。

## 2. 关键决策

| 决策 | 结论 | 理由 |
| --- | --- | --- |
| **改造范围** | 混合式：采纳 参考项目 的**呈现质量**（完整文档 / 自适应 / 品牌集中化 / 衬线体），**不**采纳其 `text\|code\|cta` block 联合类型 | 知行当前**只有一种邮件**（登录码），无第二处 `sendMail` 调用点。block 组合系统是为不存在的邮件预造抽象，违反 YAGNI。呈现质量在第一封邮件就回本；可扩展性要到第二种邮件才回本，届时再做也是小重构。 |
| **视觉方向** | 水墨留白 · 朱砂 | 宣纸暖白 + 墨色正文 + 朱砂红验证码 + 衬线体「知行」，最贴人文遗产调性，也呼应「地图中国」的文化感。 |
| **页头标语** | `知一方风土，行万里路` | 直取产品设计文档对「知行合一」的注解，短、对仗，知(风土)+行(万里路)两层一句说尽。 |
| **发件人域名** | `知行 <noreply@example.com>` | 复用 参考项目 项目在 Resend 已验证的域名，省一份域名费。SPF/DKIM 验证域名而非显示名，跨项目共用合规。纠正现状 stale 的 `noreply@example.com`。 |

## 3. 架构

`renderCodeEmail(code) → { subject, text, html }` **签名与返回结构不变**，`emailAuth.ts` 调用方零改动。`sendMail` 保持不变（仍在此统一加 `【知行】` 主题前缀）。

`mailer.ts` 内部升级：

- **`BRAND` 常量**：集中品牌文案 `{ name, tagline, footer }`，不再内联散落。
- **`C` 调色常量**：十六进制集中一处（见 §4 调色表），HTML 内联样式引用之——借鉴 参考项目 的样式集中化思路，避免色值在模板里散落难维护。
- **HTML 升级为完整文档**：`<!DOCTYPE html>` + `<html lang="zh-CN">` + `<head>`（`charset` + `viewport`）+ `<body>`。
- **移动端自适应**：内层卡片 `max-width:480px;width:100%`（替代现状固定 `width:480px`）。
- **保留 `escapeHtml`**：所有插值仍过转义（`code` 目前是纯数字，但按契约纵深防御，不因内容"看起来安全"就省略）。`BRAND.*` 为可信常量，无需转义。
- **约束不变**：表格布局 + 全内联样式（QQ 邮箱 / 163 等客户端不支持现代 CSS / 外链样式表）。

**明确不做**（YAGNI）：`EmailBlock` 联合类型、`renderEmail({heading, blocks})` 通用渲染器、CTA 按钮与 `isSafeLinkUrl` 链接护栏——当前无链接类邮件需求；待真出现第二种邮件（如"足迹审核通过"通知）再抽象。

## 4. 视觉规格（水墨留白 · 朱砂）

### 调色表（`C`）

| 用途 | 色值 |
| --- | --- |
| 邮件外底（body） | `#efe9db` 宣纸暖色 |
| 正文卡底 | `#fbf8f2` 暖白 |
| 卡片描边 / 发丝线 | `#e8dfc9` |
| 品牌字「知行」 | `#a8322a` 朱砂 |
| 标语 | `#6b6248` 暖褐灰 |
| 正文墨色 | `#3a352e` 暖墨 |
| 验证码块底 | `#faf0e9` 浅朱砂晕 |
| 验证码字 | `#a8322a` 朱砂 |
| 提示文字 | `#8a8070` |
| 页脚带底 | `#f4efe2` |
| 页脚字 | `#b3a889` |

### 字体栈

- 品牌字（衬线）：`'Songti SC','Noto Serif SC',STSong,SimSun,serif`，22px / 粗 / `letter-spacing:2px`。
- 正文（无衬线）：`-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif`，14px / `line-height:1.7`。
- 验证码（等宽）：`'Courier New',Courier,monospace`，28px / 粗 / `letter-spacing:8px` + `text-indent:8px`（补偿末位字距，视觉居中）。

### 布局结构

```
body(bg 外底)
└─ 外层 table(100% 宽, padding:32px 16px, bg 外底)
   └─ 内层卡片 table(max-width:480px;width:100%, 卡底, 1px 描边, radius:12px, overflow:hidden)
      ├─ 页头 td(padding:24px 32px 18px, 底部发丝线)
      │    · 品牌字「知行」(朱砂/衬线) + 标语「知一方风土，行万里路」(暖褐灰, padding-left:10px)
      ├─ 正文 td(padding:28px 32px 12px, 无衬线, 墨色)
      │    · <p> 你正在登录知行，本次登录验证码：
      │    · 居中验证码块(inline-block, 浅朱砂晕底, 朱砂字, radius:8px)
      │    · <p> 提示(提示色, 12px)
      └─ 页脚 td(padding:16px 32px 22px, 页脚带底, 顶部发丝线)
           · <p> 系统自动发送，请勿回复。(页脚字, 12px, 居中)
```

## 5. 文案

- **Subject**：`登录验证码`（不带前缀；`sendMail` 统一加 `【知行】` → 收件箱显示 `【知行】登录验证码`）。
- **HTML 正文**：`你正在登录知行，本次登录验证码：` → 码 → `验证码 10 分钟内有效。如非本人操作，请忽略这封邮件。`
- **页脚**：`系统自动发送，请勿回复。`
- **纯文本版**（`text`，与 HTML 同发，兜底纯文本客户端）：

  ```
  知行 · 知一方风土，行万里路

  你正在登录知行，本次登录验证码：

  {code}

  验证码 10 分钟内有效。如非本人操作，请忽略这封邮件。

  系统自动发送，请勿回复。
  ```

  码在纯文本版保持**无空格**（`068214`，便于整体复制）；HTML 版的视觉分隔由 `letter-spacing` 承担，实际文本仍是 6 位连续数字。

## 6. 配置修复

`apps/api/src/config.ts`：

```ts
from: process.env.MAIL_FROM ?? "知行 <noreply@example.com>",
```

- 纠正现状 stale 的 `noreply@example.com`（该 `.cc` 域名非项目所有，生产误发会 SPF/DKIM 不对齐 → 进垃圾箱或伪冒他域）。
- 补注释：生产环境应经 `MAIL_FROM` 环境变量覆盖；默认值须为 Resend 已验证域名。

## 7. 安全

- **HTML 转义**：`renderCodeEmail` 内所有动态插值（`code`）过 `escapeHtml`。品牌文案为可信常量。
- **发件域对齐**：`From` 域名（`example.com`）须是 Resend 已验证域名，保证 SPF/DKIM 对齐、正常投递。显示名「知行」为自由文本，不参与鉴权。
- **无网络副作用（dev/test）**：`config.smtp.url` 为空（dev/test 默认）时 `sendMail` 仅 `console.log`，绝无外发——本次改造不触碰此分支。

## 8. 测试

新增 `apps/api/test/mailer.test.ts`——**纯函数单测，免 DB、免 app.inject**（`renderCodeEmail` 无副作用）。四条契约分属**独立测试用例，各用各的输入**：

1. **主题无前缀**：以正常码渲染，`subject === "登录验证码"`（**不含** `【知行】` 前缀——前缀是 `sendMail` 的职责，避免双重前缀）。
2. **HTML 结构 + 品牌**：以正常码渲染，`html` 含：验证码字符串、品牌名 `知行`、标语 `知一方风土，行万里路`、文档骨架（正则 `/<!doctype/i`，大小写不敏感）、`viewport`（自适应契约）。
3. **纯文本无标签**：以正常码渲染，`text` 含验证码字符串，且**不含 HTML 标签**（`<` 不出现）。
4. **转义契约**（独立用例，专门构造含元字符的输入）：`renderCodeEmail('<b>&"')` 的 `html` 出现 `&lt;b&gt;` 而非裸 `<b>`（锁死转义行为，即便真实码为纯数字）。注意本用例的 `text` 版会原样含 `<b>`（纯文本不转义），故断言 3 的"无标签"仅针对正常码用例，与本用例不冲突。

采用 **TDD**：先写以上测试（现状缺标语 / doctype，断言 2 会 RED）→ 再改 `mailer.ts` 实现 → GREEN。改后跑 `pnpm -C apps/api exec vitest run` 全套回归（含既有 `email-auth.test.ts`，确认签名不变、调用方无回归）。

## 9. 实现清单

- [ ] 写 `apps/api/test/mailer.test.ts`（§8 四条契约），确认 RED。
- [ ] 改 `apps/api/src/mailer.ts`：加 `BRAND` / `C` 常量；`renderCodeEmail` 重做 `text` + `html`（完整文档 + 自适应 + 水墨留白·朱砂 + 衬线品牌字 + 标语）；保留 `escapeHtml` 与 `sendMail` 不变。
- [ ] 改 `apps/api/src/config.ts`：默认发件人 `noreply@example.com` → `noreply@example.com` + 补注释。
- [ ] `pnpm -C apps/api exec vitest run` 全绿。
- [ ] 视觉验收：本地渲染 `html` 到浏览器截图确认（宽屏 + 移动端）。
- [ ] 提交（conventional commits，中文）。

## 10. 不在本次范围

- `EmailBlock` 通用 block 系统、CTA 按钮、`isSafeLinkUrl` 护栏（待第二种邮件出现再抽象）。
- 其他邮件类型（足迹审核通过通知等）——目前无需求。
- iOS / admin 端任何改动——本次纯服务端邮件渲染。
- Resend 域名 / SMTP 凭据配置（运维事项，经环境变量注入，不入代码）。
