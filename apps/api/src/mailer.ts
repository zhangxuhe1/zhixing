import nodemailer from "nodemailer";
import { config } from "./config.js";

/** HTML 转义：所有插入邮件模板的值都要过一遍——验证码目前是纯数字，但按契约纵深防御，不因内容"看起来安全"就省略。 */
function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * 渲染登录验证码邮件的文本与 HTML 双版本。
 *
 * HTML 用表格布局 + 全内联样式（QQ 邮箱/163 等客户端不支持现代 CSS/外链样式表）：
 * 外层灰底居中，内层 480px 白色卡片，品牌头部"知行"，正文含大号等宽居中验证码块，
 * 页脚"系统自动发送请勿回复"。
 *
 * 返回的 subject 未加前缀——统一由 sendMail 加上「【知行】」前缀，调用方不应重复添加。
 */
export function renderCodeEmail(code: string): { subject: string; text: string; html: string } {
  const safeCode = escapeHtml(code);
  const subject = "登录验证码";
  const text = [
    "你正在登录知行，本次登录验证码：",
    code,
    "",
    "验证码 10 分钟内有效。如非本人操作，请忽略这封邮件。",
    "",
    "系统自动发送请勿回复。",
  ].join("\n");
  const html = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f5f5;padding:40px 0;">
  <tr>
    <td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="width:480px;background-color:#ffffff;border-radius:8px;overflow:hidden;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;">
        <tr>
          <td style="padding:24px 32px;background-color:#1f1f1f;">
            <span style="color:#ffffff;font-size:20px;font-weight:bold;">知行</span>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;color:#333333;font-size:14px;line-height:1.6;">
            <p style="margin:0 0 16px 0;">你正在登录知行，本次登录验证码：</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td align="center" style="padding:0 0 16px 0;">
                  <span style="display:inline-block;padding:12px 24px;font-family:'Courier New',Courier,monospace;font-size:28px;font-weight:bold;letter-spacing:8px;color:#1f1f1f;background-color:#f5f5f5;border-radius:6px;">${safeCode}</span>
                </td>
              </tr>
            </table>
            <p style="margin:0;color:#999999;font-size:12px;">验证码 10 分钟内有效。如非本人操作，请忽略这封邮件。</p>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 32px;background-color:#fafafa;border-top:1px solid #eeeeee;">
            <p style="margin:0;color:#bbbbbb;font-size:12px;text-align:center;">系统自动发送请勿回复</p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>`;
  return { subject, text, html };
}

/**
 * 发送邮件。`config.smtp.url` 为空（dev/test 默认）时仅 console.log 收件人/主题/正文后返回，
 * 绝无网络副作用；非空时才用 nodemailer 建立 transport 真正发信，发件人取 `config.smtp.from`。
 *
 * 主题统一在此处加「【知行】」前缀——调用方（如 renderCodeEmail）返回的 subject 不带前缀，
 * 避免出现「【知行】【知行】...」的双重前缀。
 */
export async function sendMail(to: string, subject: string, text: string, html?: string): Promise<void> {
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
  });
}
