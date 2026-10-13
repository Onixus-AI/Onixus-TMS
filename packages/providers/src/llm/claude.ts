import Anthropic from "@anthropic-ai/sdk";
import { requireVars, type Env } from "../env.js";
import { ProviderError, type Extraction, type LlmProvider } from "../types.js";

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;

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

    // A PDF goes in as a document block, a photo as an image block; the
    // answer is forced into the schema with structured outputs.
    async extractJson({ system, text, file, schema, maxTokens = 8000 }: Extraction) {
      const content: Anthropic.ContentBlockParam[] = [];
      if (file) {
        if (file.mediaType === "application/pdf") {
          content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: file.base64 } });
        } else if ((IMAGE_TYPES as readonly string[]).includes(file.mediaType)) {
          content.push({ type: "image", source: { type: "base64", media_type: file.mediaType as (typeof IMAGE_TYPES)[number], data: file.base64 } });
        } else {
          throw new ProviderError("Claude", 415, `cannot read ${file.mediaType}; send a PDF, JPEG, PNG, GIF or WebP`);
        }
      }
      content.push({ type: "text", text: text?.trim() || "Read the attached document." });
      try {
        const response = await client.messages.create({
          model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: "user", content }],
          output_config: { effort: "low", format: { type: "json_schema", schema } },
        });
        if (response.stop_reason === "refusal") throw new ProviderError("Claude", 422, `declined (${response.stop_details?.category ?? "unspecified"})`);
        if (response.stop_reason === "max_tokens") throw new ProviderError("Claude", 502, "the document was too long to read in one pass");
        const out = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
        return JSON.parse(out) as unknown;
      } catch (e) {
        if (e instanceof Anthropic.APIError) throw new ProviderError("Claude", e.status ?? 502, e.message);
        throw e;
      }
    },
  };
}
