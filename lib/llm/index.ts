// Single choke point for every LLM/embedding call in the app.
//
// - CHAT / structured extraction / re-rank -> Gemini Flash, with a Groq
//   fallback on a quota/5xx error (Google cut free quotas 50-80% in Dec 2025
//   with no notice, see REVISED-PLAN.md §3).
// - EMBEDDINGS -> Voyage AI. Gemini's free embedding tier is only 1,000/day,
//   which can't warm a ~15k-job corpus in reasonable time; Voyage gives a 200M
//   free-token allowance (no card) on the voyage-4 family at top-tier quality,
//   embeds the whole corpus in minutes, and has no punishing daily cap. Groq
//   has no embedding endpoint, so it is NOT an option here.

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

// --- Embeddings (Voyage AI) --------------------------------------------------
// Direct REST call — there is no official Vercel AI SDK Voyage provider, and the
// API is a single POST, so a thin fetch client keeps the dependency surface
// minimal. Profile and job embeddings MUST use the same model + dimension to be
// comparable; both go through here.

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
// `||` not `??`: an empty-string env var (VOYAGE_MODEL= in .env) must still fall
// back to the default, not send a blank model.
const VOYAGE_MODEL = process.env.VOYAGE_MODEL || "voyage-4";
const VOYAGE_DIM = 1024; // voyage-4 default; DB vector columns are vector(1024)
const VOYAGE_BATCH = 128; // <= 1000 texts and well under the per-request token cap

type InputType = "query" | "document";

interface VoyageResponse {
  data: { index: number; embedding: number[] }[];
}

async function voyageEmbedBatch(texts: string[], inputType: InputType): Promise<number[][]> {
  const maxRetries = 6;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(VOYAGE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({
        model: VOYAGE_MODEL,
        input: texts,
        input_type: inputType,
        output_dimension: VOYAGE_DIM,
      }),
    });

    if (res.ok) {
      const json = (await res.json()) as VoyageResponse;
      // Reorder by `index` — the API preserves order, but be defensive.
      const out = new Array<number[]>(texts.length);
      for (const d of json.data) out[d.index] = d.embedding;
      return out;
    }

    // 429 (rate limit) / 5xx are transient — honor Retry-After, else backoff.
    if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
      const ra = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(2000 * 2 ** attempt, 30000);
      await sleep(wait);
      continue;
    }

    const body = await res.text().catch(() => "");
    throw new Error(`Voyage embeddings ${res.status}: ${body.slice(0, 300)}`);
  }
}

// Embed a batch of texts. `inputType` follows Voyage's asymmetric-retrieval
// guidance: the job corpus is "document", the profile (which we match against
// the corpus) is "query".
export async function embedTexts(
  texts: string[],
  inputType: InputType = "document",
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += VOYAGE_BATCH) {
    const vecs = await voyageEmbedBatch(texts.slice(i, i + VOYAGE_BATCH), inputType);
    out.push(...vecs);
  }
  return out;
}
