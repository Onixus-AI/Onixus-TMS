import OpenAI from "openai";
import { requireVars, type Env } from "../env.js";
import { ProviderError, type LlmProvider } from "../types.js";

export const OPENAI_VARS = ["OPENAI_API_KEY"] as const;

/**
 * OpenAI Chat Completions. Also used for Onyx (see onyx.ts), which serves an
 * OpenAI-compatible endpoint, so baseURL and naming are parameters.
 */
export function openAiCompatible(opts: { name: string; label: string; apiKey: string; model: string; baseURL?: string }): LlmProvider {
  const client = new OpenAI({ apiKey: opts.apiKey, ...(opts.baseURL ? { baseURL: opts.baseURL } : {}) });
  return {
    name: opts.name,
    model: opts.model,
    async complete({ system, prompt, maxTokens = 4000 }) {
      try {
        const r = await client.chat.completions.create({
          model: opts.model,
          max_completion_tokens: maxTokens,
          messages: [...(system ? [{ role: "system" as const, content: system }] : []), { role: "user", content: prompt }],
        });
        return { text: r.choices[0]?.message?.content ?? "", model: r.model };
      } catch (e) {
        if (e instanceof OpenAI.APIError) throw new ProviderError(opts.label, e.status ?? 502, e.message);
        throw e;
      }
    },
  };
}

export function openai(env: Env): LlmProvider {
  const v = requireVars(env, "OpenAI", [...OPENAI_VARS]);
  return openAiCompatible({ name: "openai", label: "OpenAI", apiKey: v.OPENAI_API_KEY, model: env.OPENAI_MODEL?.trim() || "gpt-5" });
}
