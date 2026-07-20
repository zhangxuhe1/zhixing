import { readFileSync } from "node:fs";
import nodemailer from "nodemailer";
import { config } from "./config.js";

/** 邮件内联附件（nodemailer Attachment 的结构子集，避免对其类型声明的直接依赖）。 */
export interface MailAttachment {
  filename: string;
  content: Buffer;
  cid: string;
  contentDisposition: "inline";
}

/**
 * 品牌 logo（山径一笔）：以 CID 内联附件嵌入，而非外链/data URI——QQ 邮箱、163 等
 * 国内客户端默认拦外链图、不渲染 data URI，CID 是唯一普遍可靠的嵌图方式。
 * 原图见 design-system/知行/logo/；此处为 160px 米色圆角方块小样（16KB）。
 */
const LOGO_CID = "zhixing-logo";
// 相对路径成立依赖运行时始终以 tsx 直跑 src/（dev、Docker、vitest 皆如此）；
// 若将来改为 tsc 产物运行，需同步搬运 assets 或调整此路径。加载失败启动即崩是有意的 fail-fast。
const LOGO_PNG = readFileSync(new URL("../assets/email-logo.png", import.meta.url));

/** HTML 转义：所有插入邮件模板的值都要过一遍——验证码目前是纯数字，但按契约纵深防御，不因内容"看起来安全"就省略。 */
function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 品牌文案集中一处——页头品牌字、标语、页脚。均为可信常量，插入模板无需转义（仅动态值 code 过 escapeHtml）。 */
const BRAND = {
  name: "知行",
  tagline: "知一方风土，行万里山河",
  footer: "系统自动发送，请勿回复。",
} as const;

/**
 * 「水墨留白·朱砂」调色，集中一处便于维护——避免十六进制在模板里散落。
 * 宣纸暖白底 + 墨色正文 + 朱砂红验证码，贴知行的人文遗产气质。
 */
const C = {
  pageBg: "#efe9db", // 邮件外底：宣纸暖色
  card: "#fbf8f2", // 正文卡底：暖白
  hair: "#e8dfc9", // 描边 / 发丝线
  brand: "#a8322a", // 品牌字 / 验证码：朱砂
  muted: "#6b6248", // 标语：暖褐灰
  ink: "#3a352e", // 正文墨色
  codeBg: "#faf0e9", // 验证码块底：浅朱砂晕
  hint: "#8a8070", // 提示文字
  footBg: "#f4efe2", // 页脚带底
  foot: "#b3a889", // 页脚字
} as const;

const SERIF = "'Songti SC','Noto Serif SC',STSong,SimSun,serif";
const SANS = "-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif";
const MONO = "'Courier New',Courier,monospace";

/**
 * 渲染登录验证码邮件的文本与 HTML 双版本。
 *
 * HTML 为完整文档（<!DOCTYPE> + head/viewport meta），表格布局 + 全内联样式
 * （QQ 邮箱/163 等客户端不支持现代 CSS / 外链样式表）：宣纸暖底居中，480px 移动自适应白卡，
 * 衬线体「知行」品牌头 + 标语，正文含大号等宽居中朱砂验证码块，页脚「系统自动发送请勿回复」。
 *
 * 返回的 subject 未加前缀——统一由 sendMail 加上「【知行】」前缀，调用方不应重复添加。
 */
export function renderCodeEmail(code: string): {
  subject: string;
  text: string;
  html: string;
  attachments: MailAttachment[];
} {
  const safeCode = escapeHtml(code);
  const subject = "登录验证码";
  const text = [
    `${BRAND.name} · ${BRAND.tagline}`,
    "",
    "你正在登录知行，本次登录验证码：",
    "",
    code,
    "",
    "验证码 10 分钟内有效。如非本人操作，请忽略这封邮件。",
    "",
    BRAND.footer,
  ].join("\n");
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${C.pageBg};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.pageBg};padding:32px 16px;">
  <tr>
    <td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:${C.card};border:1px solid ${C.hair};border-radius:12px;overflow:hidden;">
        <tr>
          <td style="padding:20px 32px 16px;border-bottom:1px solid ${C.hair};">
            <table role="presentation" cellpadding="0" cellspacing="0">
              <tr>
                <td style="padding-right:12px;">
                  <img src="cid:${LOGO_CID}" width="42" height="42" alt="${BRAND.name}" style="display:block;border:0;">
                </td>
                <td>
                  <span style="font-family:${SERIF};font-size:22px;font-weight:700;letter-spacing:2px;color:${C.brand};">${BRAND.name}</span><br>
                  <span style="font-size:12px;color:${C.muted};">${BRAND.tagline}</span>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:28px 32px 12px;font-family:${SANS};color:${C.ink};font-size:14px;line-height:1.7;">
            <p style="margin:0 0 16px 0;">你正在登录知行，本次登录验证码：</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td align="center" style="padding:0 0 16px 0;">
                  <span style="display:inline-block;padding:12px 28px;font-family:${MONO};font-size:28px;font-weight:700;letter-spacing:8px;text-indent:8px;color:${C.brand};background:${C.codeBg};border-radius:8px;">${safeCode}</span>
                </td>
              </tr>
            </table>
            <p style="margin:0;color:${C.hint};font-size:12px;">验证码 10 分钟内有效。如非本人操作，请忽略这封邮件。</p>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 32px 22px;background:${C.footBg};border-top:1px solid ${C.hair};">
            <p style="margin:0;color:${C.foot};font-size:12px;text-align:center;">${BRAND.footer}</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
  const attachments: MailAttachment[] = [
    { filename: "zhixing-logo.png", content: LOGO_PNG, cid: LOGO_CID, contentDisposition: "inline" },
  ];
  return { subject, text, html, attachments };
}

/**
 * 发送邮件。`config.smtp.url` 为空（dev/test 默认）时仅 console.log 收件人/主题/正文后返回，
 * 绝无网络副作用；非空时才用 nodemailer 建立 transport 真正发信，发件人取 `config.smtp.from`。
 *
 * 主题统一在此处加「【知行】」前缀——调用方（如 renderCodeEmail）返回的 subject 不带前缀，
 * 避免出现「【知行】【知行】...」的双重前缀。
 */
export async function sendMail(
  to: string,
  subject: string,
  text: string,
  html?: string,
  attachments?: MailAttachment[],
): Promise<void> {
  const prefixedSubject = `【知行】${subject}`;

  if (!config.smtp.url) {
    console.log(`[mailer] (console 模式，未配置 SMTP_URL) to=${to} subject=${prefixedSubject}\n${text}`);
    return;
  }

  const transport = nodemailer.createTransport(config.smtp.url);
  await transport.sendMail({
    from: config.smtp.from,
    to,
    subject: prefixedSubject,
    text,
    html,
    attachments,
  });
}
