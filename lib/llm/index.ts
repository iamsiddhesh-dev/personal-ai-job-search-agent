// Single choke point for every LLM/embedding call in the app.
//
// Each caller names a TASK (not a model). Every task has its own primary +
// fallback provider/model pair, picked for that task's quality/latency/free-tier
// needs (see REVISED-PLAN.md §3 and the per-task table in the repo notes):
//   - resumeExtraction — structured facts out of a raw resume. Cerebras
//     gpt-oss-120b (fastest free-tier inference) -> Groq -> Gemini Flash last.
//   - hardening         — validates/corrects already-extracted facts (catches
//     e.g. a job mislabeled as a project). Groq -> Cerebras -> Gemini.
//   - rerank            — Stage 3 job matching. Run in token-safe batches (see
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
import { readCache, writeCache } from "./cache";

// --- Multi-key pools ---------------------------------------------------------
// Free-tier caps are PER KEY (per account), so the single highest-leverage
// scaling knob is more keys from separate accounts: 3 Groq keys is 3x the
// tokens-per-minute, 3 Gemini keys is 3x the (tiny) 20-requests-per-day.
//
// Each provider reads a comma-separated list, falling back to the original
// single-key name so existing .env files keep working:
//   GROQ_API_KEYS=key1,key2,key3     (or GROQ_API_KEY=key1)
//   GEMINI_API_KEYS=...              (or GEMINI_API_KEY=...)
//   CEREBRAS_API_KEYS=...            (or CEREBRAS_API_KEY=...)
type ProviderName = "google" | "groq" | "cerebras";

const KEY_ENV: Record<ProviderName, [plural: string, singular: string]> = {
  google: ["GEMINI_API_KEYS", "GEMINI_API_KEY"],
  groq: ["GROQ_API_KEYS", "GROQ_API_KEY"],
  cerebras: ["CEREBRAS_API_KEYS", "CEREBRAS_API_KEY"],
};

function keysFor(provider: ProviderName): string[] {
  const [plural, singular] = KEY_ENV[provider];
  const raw = `${process.env[plural] ?? ""},${process.env[singular] ?? ""}`;
  // De-duplicate so listing the same key in both vars doesn't waste an attempt.
  return [...new Set(raw.split(",").map((k) => k.trim()).filter(Boolean))];
}

// Provider clients are keyed by API key so each key gets its own client, built
// once and reused across requests.
const clientCache = new Map<string, (model: string) => LanguageModel>();

function clientFor(provider: ProviderName, apiKey: string): (model: string) => LanguageModel {
  const cacheKey = `${provider}:${apiKey}`;
  let client = clientCache.get(cacheKey);
  if (!client) {
    client =
      provider === "google"
        ? createGoogleGenerativeAI({ apiKey })
        : provider === "groq"
          ? createGroq({ apiKey })
          : // Cerebras exposes an OpenAI-compatible endpoint (cloud.cerebras.ai).
            // supportsStructuredOutputs is REQUIRED: without it the compat
            // provider downgrades to `response_format: json_object` and merely
            // describes the schema in the prompt, which the model then fails to
            // follow on anything non-trivial (measured 0/3 on our real
            // schemas). Cerebras does accept strict `json_schema` natively —
            // verified against the raw REST API — and scores reliably with it.
            createOpenAICompatible({
              name: "cerebras",
              baseURL: "https://api.cerebras.ai/v1",
              apiKey,
              supportsStructuredOutputs: true,
            });
    clientCache.set(cacheKey, client);
  }
  return client;
}

// Rotating start offset per provider, so consecutive requests don't all hammer
// key #1 and leave the rest idle. Advanced once per call, not per retry.
const rotation: Record<ProviderName, number> = { google: 0, groq: 0, cerebras: 0 };

function nextStart(provider: ProviderName, keyCount: number): number {
  const i = rotation[provider] % keyCount;
  rotation[provider] = (rotation[provider] + 1) % keyCount;
  return i;
}

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
// NOTE: groq's gpt-oss-20b is deliberately unused. It is faster but scored only
// 2/3 on the real rerank schema, and a silent quality drop is worse than a
// slightly slower correct answer.
// Cerebras' available model set varies by account/tier — gpt-oss-120b is what
// this key has access to (verified via GET /v1/models); llama-3.3-70b 404'd.
const CEREBRAS_GPT_OSS_120B = "gpt-oss-120b";

export type LlmTask = "resumeExtraction" | "hardening" | "rerank" | "draftGeneration";

interface ModelStep {
  provider: ProviderName;
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

// Structured generation, routed by task.
//
// Two nested loops, in this order deliberately:
//   1. model steps  — the task's chain, best-fit model first.
//   2. API keys     — every key for that step's provider.
// Keys are the INNER loop because a rate limit is per key: when key #1 is
// throttled, key #2 on another account is unaffected and answers immediately,
// which is far better than degrading to a weaker model. Only when every key for
// a provider is exhausted do we drop to the next model.
//
// A non-retryable error (e.g. a genuinely malformed prompt) throws at once
// rather than burning the whole matrix.
//
// cacheTtlMs, when set, checks/writes a DB cache keyed on (task, sha256 of the
// exact prompt) before/after the chain — see lib/llm/cache.ts for why this
// exists instead of more API keys. Omit it for prompts that are expected to
// differ every call (e.g. draft generation's correction-retry loop), where a
// cache would never hit and is pure overhead.
export async function extractStructured<S extends ZodTypeAny>(params: {
  task: LlmTask;
  prompt: string;
  schema: S;
  cacheTtlMs?: number;
}): Promise<z.infer<S>> {
  if (params.cacheTtlMs) {
    const cached = await readCache(params.task, params.prompt, params.cacheTtlMs);
    // Re-validate through the current zod schema rather than trusting the
    // stored shape blindly — guards against a schema change since the row was
    // written.
    if (cached) {
      const parsed = params.schema.safeParse(cached);
      if (parsed.success) return parsed.data as z.infer<S>;
    }
  }

  const chain = TASK_ROUTES[params.task]
    .map((step) => ({ step, keys: keysFor(step.provider) }))
    .filter(({ keys }) => keys.length > 0);

  if (chain.length === 0) {
    throw new Error(
      `No API key configured for any provider in the "${params.task}" chain. Set GROQ_API_KEYS, GEMINI_API_KEYS, or CEREBRAS_API_KEYS (comma-separated).`,
    );
  }

  let lastErr: unknown;
  for (const { step, keys } of chain) {
    const start = nextStart(step.provider, keys.length);
    for (let n = 0; n < keys.length; n++) {
      const apiKey = keys[(start + n) % keys.length];
      try {
        const { object } = await generateObject({
          model: clientFor(step.provider, apiKey)(step.model),
          schema: params.schema,
          prompt: params.prompt,
        });
        if (params.cacheTtlMs) await writeCache(params.task, params.prompt, object);
        return object as z.infer<S>;
      } catch (err) {
        lastErr = err;
        if (!shouldFailOver(err)) throw err;
        // Only pause when there is nothing else to try for this provider —
        // rotating to a fresh key clears a per-key rate limit instantly, so
        // sleeping first would waste that time for nothing.
        const isLastKeyOfLastStep =
          n === keys.length - 1 && step === chain[chain.length - 1].step;
        if (n === keys.length - 1 && !isLastKeyOfLastStep && looksLikeQuotaOrServerError(err)) {
          await sleep(retryAfterMs(err));
        }
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
