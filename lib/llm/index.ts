// Single choke point for every LLM/embedding call in the app.
//
// - CHAT / structured extraction / re-rank -> Gemini Flash, with a Groq
//   fallback on a quota/5xx error (Google cut free quotas 50-80% in Dec 2025
//   with no notice, see REVISED-PLAN.md §3).
// - EMBEDDINGS -> Cohere (embed-v4.0, 1024-dim). Gemini's free tier is 1,000/day
//   and Voyage's no-card tier is 3 req/min (too fragile — any second consumer
//   starves it). Cohere's free trial key needs no card and allows 2,000
//   inputs/min, which warms the ~15k corpus in ~10min and tolerates concurrent
//   use. Groq has no embedding endpoint, so it is NOT an option here.

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { generateObject } from "ai";
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

// --- Embeddings (Cohere) -----------------------------------------------------
// Direct REST call (thin fetch client, no extra dependency). Cohere's free trial
// key needs no payment method and allows 2,000 inputs/min — orders of magnitude
// above Voyage's no-card 3 RPM, which was too fragile to warm the corpus while
// anything else touched the key. embed-v4.0 at output_dimension 1024 matches our
// vector(1024) columns. Profile and job embeddings MUST use the same model +
// dimension to be comparable; both go through here.
// Trial cap: 1,000 API calls/month — the full ~15k corpus is ~162 calls (96
// texts each), so plenty of headroom for incremental re-runs + profile builds.

const COHERE_URL = "https://api.cohere.com/v2/embed";
// `||` not `??`: an empty-string env var (COHERE_MODEL= in .env) must still fall
// back to the default, not send a blank model.
const COHERE_MODEL = process.env.COHERE_MODEL || "embed-v4.0";
const COHERE_DIM = 1024;
const COHERE_BATCH = 96; // Cohere's hard max texts per request

type InputType = "query" | "document";

interface CohereResponse {
  embeddings: { float: number[][] };
}

async function cohereEmbedBatch(texts: string[], inputType: InputType): Promise<number[][]> {
  const maxRetries = 6;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(COHERE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.COHERE_API_KEY}`,
      },
      body: JSON.stringify({
        model: COHERE_MODEL,
        texts,
        input_type: inputType === "query" ? "search_query" : "search_document",
        output_dimension: COHERE_DIM,
        embedding_types: ["float"],
      }),
    });

    if (res.ok) {
      const json = (await res.json()) as CohereResponse;
      return json.embeddings.float;
    }

    // 429 (rate limit) / 5xx are transient — honor Retry-After, else backoff.
    if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
      const ra = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(2000 * 2 ** attempt, 30000);
      await sleep(wait);
      continue;
    }

    const body = await res.text().catch(() => "");
    throw new Error(`Cohere embeddings ${res.status}: ${body.slice(0, 300)}`);
  }
}

// Embed a batch of texts. `inputType` maps to Cohere's asymmetric-retrieval
// types: the job corpus is "document" (search_document), the profile (which we
// match against the corpus) is "query" (search_query).
export async function embedTexts(
  texts: string[],
  inputType: InputType = "document",
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += COHERE_BATCH) {
    const vecs = await cohereEmbedBatch(texts.slice(i, i + COHERE_BATCH), inputType);
    out.push(...vecs);
  }
  return out;
}
