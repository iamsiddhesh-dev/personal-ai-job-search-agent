// Single choke point for every LLM/embedding call in the app.
//
// Each caller names a TASK (not a model). Every task has its own ordered
// fallback CHAIN of provider/model steps, picked for that task's
// quality/latency/free-tier needs:
//   - resumeExtraction — structured facts out of a raw resume. Cerebras
//     gpt-oss-120b (fastest free-tier inference) -> Groq gpt-oss-120b ->
//     Gemini Flash as a last resort.
//   - hardening         — validates/corrects already-extracted facts (catches
//     e.g. a job mislabeled as a project). Groq -> Cerebras -> Gemini.
//   - rerank            — Stage 3 job matching, run in token-safe batches (see
//     lib/agent/match.ts, which is what stops a Groq TPM cap from crashing the
//     whole rerank again). Cerebras -> Groq -> Gemini.
//   - draftGeneration   — outreach note text. Groq -> Cerebras -> Gemini.
//
// EMBEDDINGS -> Cohere (embed-v4.0, 1024-dim), unrelated to the task routing
// above (Groq/Cerebras have no embedding endpoint).

import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateObject, NoObjectGeneratedError, type LanguageModel } from "ai";
import type { ZodTypeAny, z } from "zod";

// The SDK's default providers read GOOGLE_GENERATIVE_AI_API_KEY / GROQ_API_KEY.
// We name ours GEMINI_API_KEY (per .env.example) so wire it in explicitly.
const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY });
const groq = createGroq({ apiKey: process.env.GROQ_API_KEY });
// Cerebras exposes an OpenAI-compatible endpoint (cloud.cerebras.ai, free,
// no card). Optional: tasks that fall back to it just skip that hop when the
// key is unset (see hasKey below).
const cerebras = createOpenAICompatible({
  name: "cerebras",
  baseURL: "https://api.cerebras.ai/v1",
  apiKey: process.env.CEREBRAS_API_KEY,
});

// "gemini-2.5-flash" was rejected live: "no longer available to new users"
// for a freshly created API key (Google model lifecycle, not our bug — see
// REVISED-PLAN.md §3 free-tier-quotas-move warning). Use the rolling alias so
// this doesn't need touching again every time Google retires a pinned version.
// IMPORTANT: every model named here MUST support enforced json_schema output,
// and must be verified against a REAL schema from this codebase — a toy schema
// proves nothing (a model that passes a flat 4-field probe can still score 0/3
// on the resume schema).
// Do NOT use groq's llama-3.3-70b-versatile / llama-3.1-8b-instant /
// qwen3.6-27b here: they hard-fail with "does not support response format
// `json_schema`" (only Groq's gpt-oss family supports it). That mistake broke
// draft generation in production — re-verify with a probe before adding a model.
const GEMINI_FLASH = "gemini-flash-latest";
const GROQ_GPT_OSS_120B = "openai/gpt-oss-120b";
// Cerebras' available model set varies by account/tier — gpt-oss-120b is what
// this key has access to (verified via GET /v1/models); llama-3.3-70b 404'd.
const CEREBRAS_GPT_OSS_120B = "gpt-oss-120b";

export type LlmTask = "resumeExtraction" | "hardening" | "rerank" | "draftGeneration";

interface ModelStep {
  provider: "google" | "groq" | "cerebras";
  model: string;
}

// Each task gets an ordered CHAIN, tried top to bottom. Steps whose provider
// has no key configured are skipped. A chain (rather than a single fallback)
// means one provider's free-tier quota running dry degrades quality slightly
// instead of failing the request.
const TASK_ROUTES: Record<LlmTask, ModelStep[]> = {
  resumeExtraction: [
    { provider: "cerebras", model: CEREBRAS_GPT_OSS_120B },
    { provider: "groq", model: GROQ_GPT_OSS_120B },
    { provider: "google", model: GEMINI_FLASH },
  ],
  // Non-fatal by design (see hardenResumeFacts) — leads with Groq since it's
  // the least quality-critical task.
  hardening: [
    { provider: "groq", model: GROQ_GPT_OSS_120B },
    { provider: "cerebras", model: CEREBRAS_GPT_OSS_120B },
    { provider: "google", model: GEMINI_FLASH },
  ],
  rerank: [
    { provider: "cerebras", model: CEREBRAS_GPT_OSS_120B },
    { provider: "groq", model: GROQ_GPT_OSS_120B },
    { provider: "google", model: GEMINI_FLASH },
  ],
  draftGeneration: [
    { provider: "groq", model: GROQ_GPT_OSS_120B },
    { provider: "cerebras", model: CEREBRAS_GPT_OSS_120B },
    { provider: "google", model: GEMINI_FLASH },
  ],
};

function resolveModel(step: ModelStep): LanguageModel {
  switch (step.provider) {
    case "google":
      return google(step.model);
    case "groq":
      return groq(step.model);
    case "cerebras":
      return cerebras(step.model);
  }
}

function looksLikeQuotaOrServerError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|quota|rate.?limit|RESOURCE_EXHAUSTED|5\d\d/i.test(msg);
}

// Reasons to move to the next step in a chain: a quota/server outage, or the
// model failing to produce schema-valid output. The latter can mean a genuine
// prompt bug, but it also happens when a model doesn't truly enforce
// json_schema — so retrying on the next provider is the right call. If it IS a
// prompt bug, every step fails and the last error surfaces.
function shouldFailOver(err: unknown): boolean {
  if (looksLikeQuotaOrServerError(err) || NoObjectGeneratedError.isInstance(err)) return true;
  // Groq's strict json_schema mode returns a 400 "Failed to validate JSON" when
  // the model can't satisfy the schema. Like NoObjectGeneratedError that's a
  // capability limit rather than a bad request, so another model deserves a go.
  const msg = err instanceof Error ? err.message : String(err);
  return /failed to validate json|failed_generation|does not support response format/i.test(msg);
}

// Providers state how long to wait in the error text ("Please retry in 24.02s",
// "try again in 1m30s"). Honor it when present so we wait the real amount
// rather than a guess; cap it so a long daily-quota reset doesn't hang a
// request that could just move to the next provider.
function retryAfterMs(err: unknown): number {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/(?:retry|try again) in\s*(?:(\d+)m)?\s*([\d.]+)s/i);
  if (m) {
    const mins = m[1] ? Number(m[1]) : 0;
    const secs = Number(m[2]);
    const total = (mins * 60 + secs) * 1000;
    if (Number.isFinite(total)) return Math.min(total + 250, 20000);
  }
  return 3000;
}

function hasKey(provider: ModelStep["provider"]): boolean {
  switch (provider) {
    case "google":
      return !!process.env.GEMINI_API_KEY;
    case "groq":
      return !!process.env.GROQ_API_KEY;
    case "cerebras":
      return !!process.env.CEREBRAS_API_KEY;
  }
}

// Structured generation, routed by task. Walks the task's chain in order,
// skipping steps whose provider has no key, and moving on when a step fails in
// a retryable way. A non-retryable error (e.g. a malformed prompt) throws
// immediately rather than burning the rest of the chain.
export async function extractStructured<S extends ZodTypeAny>(params: {
  task: LlmTask;
  prompt: string;
  schema: S;
}): Promise<z.infer<S>> {
  const chain = TASK_ROUTES[params.task].filter((step) => hasKey(step.provider));
  if (chain.length === 0) {
    throw new Error(
      `No API key configured for any provider in the "${params.task}" chain. Set GEMINI_API_KEY, GROQ_API_KEY, or CEREBRAS_API_KEY.`,
    );
  }

  let lastErr: unknown;
  for (let i = 0; i < chain.length; i++) {
    const step = chain[i];
    const isLastStep = i === chain.length - 1;
    // A per-minute token/request cap is transient — waiting clears it. Retry
    // the same step before advancing, otherwise a brief burst would burn
    // through the whole chain and land on Gemini, whose free tier is only 20
    // requests per DAY and must be conserved.
    const attempts = isLastStep ? 1 : 2;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const { object } = await generateObject({
          model: resolveModel(step),
          schema: params.schema,
          prompt: params.prompt,
        });
        return object as z.infer<S>;
      } catch (err) {
        lastErr = err;
        if (!shouldFailOver(err)) throw err;
        const retryable = looksLikeQuotaOrServerError(err) && attempt < attempts - 1;
        if (!retryable) break;
        await sleep(retryAfterMs(err));
      }
    }
  }
  throw lastErr;
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
