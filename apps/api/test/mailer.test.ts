import { expect, test } from "vitest";
import { renderCodeEmail } from "../src/mailer.js";

// renderCodeEmail 是纯函数：无 DB、无网络、无 app.inject——直接断言渲染契约。
// 与 email-auth.test.ts 分工：那边测发码/校验的库行为，这边只测邮件渲染的形状与转义。
// 用例 2 是本次改造的 RED 驱动（现状缺标语/文档骨架）；用例 1/3/4 是护栏，锁死重做时不得破坏的契约。

const CODE = "068214";

test("用例1 主题无前缀：subject 为「登录验证码」，不带【知行】（前缀是 sendMail 的职责，避免双重前缀）", () => {
  const { subject } = renderCodeEmail(CODE);
  expect(subject).toBe("登录验证码");
  expect(subject).not.toContain("【知行】");
});

test("用例2 HTML 结构与品牌：含验证码 / 品牌名 / 标语 / 文档骨架 / viewport", () => {
  const { html, text } = renderCodeEmail(CODE);
  expect(html).toContain(CODE);
  expect(html).toContain("知行");
  expect(html).toContain("知一方风土，行万里山河");
  expect(text).toContain("知一方风土，行万里山河");
  expect(html).not.toContain("知一方风土，行万里路");
  expect(html).toMatch(/<!doctype/i); // 完整 HTML 文档骨架（现状缺）
  expect(html).toContain("viewport"); // 移动端自适应（现状缺）
});

test("用例3 纯文本无标签：text 含验证码，且不出现 HTML 标签（兜底纯文本客户端）", () => {
  const { text } = renderCodeEmail(CODE);
  expect(text).toContain(CODE);
  expect(text).not.toContain("<");
});

test("用例4 转义契约：含元字符的输入被转义（&lt;b&gt; 而非裸 <b>），锁死纵深防御", () => {
  const { html } = renderCodeEmail('<b>&"');
  expect(html).toContain("&lt;b&gt;");
  expect(html).not.toContain("<b>");
});
