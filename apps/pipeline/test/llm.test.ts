import { expect, test } from "vitest";
import { DEFAULT_MODELS, resolveProvider } from "../src/llm.js";

test("显式 ZHIXING_LLM_PROVIDER 优先", () => {
  expect(resolveProvider({ ZHIXING_LLM_PROVIDER: "deepseek", GEMINI_API_KEY: "g" })).toBe("deepseek");
  expect(resolveProvider({ ZHIXING_LLM_PROVIDER: "gemini", DEEPSEEK_API_KEY: "d" })).toBe("gemini");
});

test("未显式指定时按已配置的 Key 自动选择，gemini 优先", () => {
  expect(resolveProvider({ GEMINI_API_KEY: "g", DEEPSEEK_API_KEY: "d" })).toBe("gemini");
  expect(resolveProvider({ DEEPSEEK_API_KEY: "d" })).toBe("deepseek");
});

test("无凭据时报错，非法 provider 报错", () => {
  expect(() => resolveProvider({})).toThrow(/GEMINI_API_KEY|DEEPSEEK_API_KEY/);
  expect(() => resolveProvider({ ZHIXING_LLM_PROVIDER: "gpt", GEMINI_API_KEY: "g" })).toThrow(/provider/i);
});

test("两个 provider 都有默认模型", () => {
  expect(DEFAULT_MODELS.gemini).toBeTruthy();
  expect(DEFAULT_MODELS.deepseek).toBeTruthy();
});
