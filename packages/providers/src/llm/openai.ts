import OpenAI from "openai";
import { requireVars, type Env } from "../env.js";
import { ProviderError, type Extraction, type LlmProvider } from "../types.js";

export const OPENAI_VARS = ["OPENAI_API_KEY"] as const;

/**
 * OpenAI Chat Completions. Also used for Onyx (see onyx.ts), which serves an
 * OpenAI-compatible endpoint, so baseURL and naming are parameters.
 */
export function openAiCompatible(opts: { name: string; label: string; apiKey: string; model: string; baseURL?: string; extraBody?: Record<string, unknown> }): LlmProvider {
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

    // A PDF goes in as a file part, a photo as an image part, both as data
    // URLs; the answer is held to the JSON Schema with response_format.
    async extractJson({ system, text, file, schema, maxTokens = 8000 }: Extraction) {
      const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
      if (file) {
        const dataUrl = `data:${file.mediaType};base64,${file.base64}`;
        if (file.mediaType === "application/pdf") parts.push({ type: "file", file: { filename: "document.pdf", file_data: dataUrl } });
        else if (file.mediaType.startsWith("image/")) parts.push({ type: "image_url", image_url: { url: dataUrl } });
        else throw new ProviderError(opts.label, 415, `cannot read ${file.mediaType}; send a PDF or an image`);
      }
      parts.push({ type: "text", text: text?.trim() || "Read the attached document." });
      try {
        const r = await client.chat.completions.create({
          model: opts.model,
          max_completion_tokens: maxTokens,
          messages: [{ role: "system", content: system }, { role: "user", content: parts }],
          response_format: { type: "json_schema", json_schema: { name: "extraction", strict: true, schema } },
          ...(opts.extraBody ?? {}),
        } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);
        const choice = r.choices[0];
        if (choice?.finish_reason === "length") throw new ProviderError(opts.label, 502, "the document was too long to read in one pass");
        const out = choice?.message?.content;
        if (!out) throw new ProviderError(opts.label, 502, choice?.message?.refusal ? `declined: ${choice.message.refusal}` : "empty answer");
        // Some models wrap JSON in a code fence even in JSON mode.
        return JSON.parse(out.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, "")) as unknown;
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
