import { requireVars, type Env } from "../env.js";
import type { LlmProvider } from "../types.js";
import { openAiCompatible } from "./openai.js";

// Onyx, the Onixus model gateway, speaks the OpenAI-compatible chat API, so
// it reuses that client with its own base URL, key and model.
export const ONYX_LLM_VARS = ["ONYX_BASE_URL", "ONYX_API_KEY", "ONYX_MODEL"] as const;

export function onyxLlm(env: Env): LlmProvider {
  const v = requireVars(env, "Onyx", [...ONYX_LLM_VARS]);
  return openAiCompatible({ name: "onyx", label: "Onyx", apiKey: v.ONYX_API_KEY, model: v.ONYX_MODEL, baseURL: v.ONYX_BASE_URL });
}
