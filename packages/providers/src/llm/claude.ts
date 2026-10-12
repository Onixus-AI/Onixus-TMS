import Anthropic from "@anthropic-ai/sdk";
import { requireVars, type Env } from "../env.js";
import { ProviderError, type LlmProvider } from "../types.js";

export const CLAUDE_VARS = ["ANTHROPIC_API_KEY"] as const;
export const CLAUDE_DEFAULT_MODEL = "claude-opus-5-5";

export function claude(env: Env): LlmProvider {
  const v = requireVars(env, "Claude", [...CLAUDE_VARS]);
  const model = env.CLAUDE_MODEL?.trim() || CLAUDE_DEFAULT_MODEL;
  const client = new Anthropic({ apiKey: v.ANTHROPIC_API_KEY });

  return {
    name: "claude",
    model,
    async complete({ system, prompt, maxTokens = 16000 }) {
      try {
        const response = await client.messages.create({
          model,
          max_tokens: maxTokens,
          ...(system ? { system } : {}),
          messages: [{ role: "user", content: prompt }],
        });
        if (response.stop_reason === "refusal") {
          throw new ProviderError("Claude", 422, `declined (${response.stop_details?.category ?? "unspecified"})`);
        }
        const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
        return { text, model: response.model };
      } catch (e) {
        if (e instanceof Anthropic.APIError) throw new ProviderError("Claude", e.status ?? 502, e.message);
        throw e;
      }
    },
  };
}
