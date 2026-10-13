import { requireVars, type Env } from "../env.js";
import type { LlmProvider } from "../types.js";
import { openAiCompatible } from "./openai.js";

// OpenRouter: one key, hundreds of models, OpenAI-compatible API. The default
// is a low-cost model that reads PDFs and photos and supports structured
// outputs; set OPENROUTER_MODEL to any model id from openrouter.ai/models.
export const OPENROUTER_VARS = ["OPENROUTER_API_KEY"] as const;
export const OPENROUTER_DEFAULT_MODEL = "google/gemini-2.5-flash";

export function openrouter(env: Env): LlmProvider {
  const v = requireVars(env, "OpenRouter", [...OPENROUTER_VARS]);
  return openAiCompatible({
    name: "openrouter",
    label: "OpenRouter",
    apiKey: v.OPENROUTER_API_KEY,
    model: env.OPENROUTER_MODEL?.trim() || OPENROUTER_DEFAULT_MODEL,
    baseURL: env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1",
    // Only route to providers that honour the JSON Schema we send.
    extraBody: { provider: { require_parameters: true } },
  });
}
