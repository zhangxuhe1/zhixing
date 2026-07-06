import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";

export type Provider = "gemini" | "deepseek";

export const DEFAULT_MODELS: Record<Provider, string> = {
  gemini: "gemini-2.5-pro",
  deepseek: "deepseek-chat",
};

type Env = Record<string, string | undefined>;

export function resolveProvider(env: Env = process.env): Provider {
  const explicit = env.ZHIXING_LLM_PROVIDER;
  if (explicit) {
    if (explicit !== "gemini" && explicit !== "deepseek") {
      throw new Error(`非法 ZHIXING_LLM_PROVIDER: ${explicit}（可选 gemini | deepseek）`);
    }
    return explicit;
  }
  if (env.GEMINI_API_KEY) return "gemini";
  if (env.DEEPSEEK_API_KEY) return "deepseek";
  throw new Error("未配置 LLM 凭据：请设置 GEMINI_API_KEY 或 DEEPSEEK_API_KEY（.env 或环境变量）");
}

export interface LlmClient {
  provider: Provider;
  model: string;
  /** 是否支持联网检索（研究步骤）；deepseek 不支持，检索步骤将跳过 */
  canWebSearch: boolean;
  /** 联网检索并汇集素材，返回纯文本笔记 */
  research(prompt: string): Promise<string>;
  /** 生成 JSON 响应并解析（调用方用 zod 校验结构） */
  generateJson(prompt: string): Promise<unknown>;
}

function requireKey(env: Env, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`缺少环境变量 ${name}`);
  return v;
}

export function createLlm(env: Env = process.env): LlmClient {
  const provider = resolveProvider(env);
  const model = env.ZHIXING_GEN_MODEL ?? DEFAULT_MODELS[provider];

  if (provider === "gemini") {
    const ai = new GoogleGenAI({ apiKey: requireKey(env, "GEMINI_API_KEY") });
    return {
      provider,
      model,
      canWebSearch: true,
      async research(prompt) {
        const res = await ai.models.generateContent({
          model,
          contents: prompt,
          config: { tools: [{ googleSearch: {} }] },
        });
        return res.text ?? "";
      },
      async generateJson(prompt) {
        const res = await ai.models.generateContent({
          model,
          contents: prompt,
          config: { responseMimeType: "application/json" },
        });
        return JSON.parse(res.text ?? "");
      },
    };
  }

  const client = new OpenAI({
    apiKey: requireKey(env, "DEEPSEEK_API_KEY"),
    baseURL: "https://api.deepseek.com",
  });
  return {
    provider,
    model,
    canWebSearch: false,
    async research() {
      throw new Error("deepseek 不支持联网检索；请用 --no-web-search 或配置 GEMINI_API_KEY");
    },
    async generateJson(prompt) {
      const res = await client.chat.completions.create({
        model,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
      });
      return JSON.parse(res.choices[0]?.message?.content ?? "");
    },
  };
}
