// Single choke point for every LLM call in the app. Route model choice and
// the Gemini -> Groq fallback here so a quota change (Google cut free quotas
// 50-80% in Dec 2025 with no notice, see REVISED-PLAN.md §3) is a one-file fix.

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { generateObject, embedMany } from "ai";
import type { ZodTypeAny, z } from "zod";

// The SDK's default providers read GOOGLE_GENERATIVE_AI_API_KEY / GROQ_API_KEY.
// We name ours GEMINI_API_KEY (per .env.example) so wire it in explicitly.
const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY });
const groq = createGroq({ apiKey: process.env.GROQ_API_KEY });

// "gemini-2.5-flash" was rejected live: "no longer available to new users"
// for a freshly created API key (Google model lifecycle, not our bug — see
// REVISED-PLAN.md §3 free-tier-quotas-move warning). Use the rolling alias so
// this doesn't need touching again every time Google retires a pinned version.
const GEMINI_FLASH = "gemini-flash-latest";
const GROQ_FALLBACK_MODEL = "openai/gpt-oss-120b";
const EMBEDDING_MODEL = "gemini-embedding-001";

function looksLikeQuotaOrServerError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|quota|rate.?limit|RESOURCE_EXHAUSTED|5\d\d/i.test(msg);
}

// Structured extraction (resume facts, profile merge, job re-rank). Gemini
// Flash first; falls back to Groq's OpenAI-compatible endpoint only on a
// quota/server error, never on a validation error (that's a prompt bug, not
// an outage).
export async function extractStructured<S extends ZodTypeAny>(params: {
  prompt: string;
  schema: S;
}): Promise<z.infer<S>> {
  try {
    const { object } = await generateObject({
      model: google(GEMINI_FLASH),
      schema: params.schema,
      prompt: params.prompt,
    });
    return object as z.infer<S>;
  } catch (err) {
    if (!looksLikeQuotaOrServerError(err)) throw err;
    const { object } = await generateObject({
      model: groq(GROQ_FALLBACK_MODEL),
      schema: params.schema,
      prompt: params.prompt,
    });
    return object as z.infer<S>;
  }
}

// Batch embeddings for profile/job vectors. Gemini's embedding model has a
// tight free-tier limit (~100 embed_content units per minute, and each text
// counts) with no Groq fallback available — Groq has no embedding endpoint. So
// unlike extractStructured, the only correct response to a 429 here is to wait
// out the window the server tells us to and retry, not to fail the run.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function retryDelayMs(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  if (!looksLikeQuotaOrServerError(err)) return null;
  const m = msg.match(/retry in ([\d.]+)s/i) ?? msg.match(/retryDelay["\s:]+([\d.]+)s/i);
  const secs = m ? Number(m[1]) : 60;
  return Math.ceil(secs + 3) * 1000; // small buffer past the server's window
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const maxRetries = 6;
  for (let attempt = 0; ; attempt++) {
    try {
      const { embeddings } = await embedMany({
        model: google.embedding(EMBEDDING_MODEL),
        values: texts,
        maxParallelCalls: 1, // don't burst parallel sub-requests into the per-minute cap
        maxRetries: 0, // we own the retry loop so we can honor the server's retryDelay
      });
      return embeddings;
    } catch (err) {
      const wait = retryDelayMs(err);
      if (wait === null || attempt >= maxRetries) throw err;
      await sleep(wait);
    }
  }
}
