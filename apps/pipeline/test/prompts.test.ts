import { expect, test } from "vitest";
import { buildCardPrompt, buildResearchPrompt, CATEGORY_LABELS, TEMPLATE_RULES } from "../src/prompts.js";

test("写作规则包含规格书 §3.3 的关键约束", () => {
  expect(TEMPLATE_RULES).toContain("300");
  expect(TEMPLATE_RULES).toContain("细节锚点");
  expect(TEMPLATE_RULES).toContain("相传");
  expect(TEMPLATE_RULES).toContain("不总结、不升华");
});

test("研究 prompt 带地点与分类", () => {
  const p = buildResearchPrompt("什刹海", "北京市", "ANECDOTE");
  expect(p).toContain("什刹海");
  expect(p).toContain("北京市");
  expect(p).toContain(CATEGORY_LABELS.ANECDOTE);
});

test("写卡 prompt 包含规则、资料与已有标题去重要求", () => {
  const p = buildCardPrompt({
    placeName: "什刹海",
    cityName: "北京市",
    category: "FOOD",
    notes: "【资料】烤肉季始于清道光年间……",
    existingTitles: ["银锭观山"],
  });
  expect(p).toContain(TEMPLATE_RULES);
  expect(p).toContain("烤肉季");
  expect(p).toContain("银锭观山");
});
