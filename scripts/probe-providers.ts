// Provider qualification harness (SCALE-PLAN Phase D.3).
//
// No provider gets added to a chain in lib/llm/index.ts until it has passed
// this. The rule exists because it has already been broken once, in production:
// groq's llama-3.3-70b advertised json_schema support, passed a hand-written
// toy probe, and then silently failed draft generation on the real schema. A
// second time with Cerebras, where omitting `supportsStructuredOutputs` made
// the compat provider quietly downgrade to `response_format: json_object` and
// merely DESCRIBE the schema in the prompt — 0/3 on the resume schema, no error
// anywhere. See the comment at lib/llm/index.ts:96.
//
// So this probes the two REAL schemas the app actually depends on, three times
// each (a model that fails intermittently is a model that fails), plus tool
// calling, which is a separate capability and the one chatModelChain() needs.
//
// Run:  npm run probe:providers                 (everything with a key set)
//       npm run probe:providers -- openrouter   (just one)
//       npm run probe:providers -- groq a,b     (that provider, those models)
//
// Adding a candidate model: put it in CANDIDATES below. Nothing here writes to
// the database or to lib/llm — a pass is a licence to edit TASK_ROUTES or
// chatModelChain by hand, not an automatic promotion.

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createGroq } from "@ai-sdk/groq";
import { generateObject, generateText, stepCountIs, tool, type LanguageModel } from "ai";
import { z } from "zod";
import { resumeFactsSchema } from "@/lib/profile/resume";
import { rerankSchema } from "@/lib/agent/match";
import { looksLikeQuotaOrServerError } from "@/lib/llm";

// Every candidate here speaks the OpenAI-compatible API, which is why they are
// all built the same way. `supportsStructuredOutputs: true` is NOT optional and
// NOT a guess — without it the compat provider downgrades to json_object mode
// and the probe measures the wrong thing entirely (see the header).
interface Candidate {
  provider: string;
  envVar: string;
  baseURL: string;
  models: string[];
  // Where a human goes to get the key, printed when the var is missing.
  console: string;
  // Build the client the way lib/llm WOULD for this provider. Defaults to the
  // OpenAI-compatible adapter, which is what a new provider gets. This is not a
  // detail: probing through a different adapter measures the adapter.
  // Calibration found this the hard way — groq's gpt-oss-120b, the production
  // chat model, scored 0/3 on tool calling through the compat adapter with
  // "property 'reasoning_content' is unsupported", because it is a reasoning
  // model and only @ai-sdk/groq knows to strip that field before echoing the
  // assistant turn back. The model was fine; the harness was wrong.
  client?: (apiKey: string) => (model: string) => LanguageModel;
}

const CANDIDATES: Candidate[] = [
  {
    provider: "openrouter",
    envVar: "OPENROUTER_API_KEY",
    baseURL: "https://openrouter.ai/api/v1",
    // Free tier ids carry the `:free` suffix and DO change — openrouter retires
    // and renames them. If one 404s, check https://openrouter.ai/models?max_price=0
    // and update this list rather than assuming the provider is broken.
    models: [
      "meta-llama/llama-3.3-70b-instruct:free",
      "qwen/qwen-2.5-72b-instruct:free",
      "deepseek/deepseek-chat-v3-0324:free",
    ],
    console: "openrouter.ai/keys (free tier, no card)",
  },
  {
    provider: "mistral",
    envVar: "MISTRAL_API_KEY",
    baseURL: "https://api.mistral.ai/v1",
    models: ["mistral-small-latest", "open-mistral-nemo"],
    console: "console.mistral.ai (free 'Experiment' tier, no card)",
  },
  {
    provider: "together",
    envVar: "TOGETHER_API_KEY",
    baseURL: "https://api.together.xyz/v1",
    models: ["meta-llama/Llama-3.3-70B-Instruct-Turbo-Free"],
    console: "api.together.ai/settings/api-keys (free tier models only)",
  },
  // Not a candidate — this is the harness calibrating itself, and it is only
  // run when asked for by name (`npm run probe:providers -- groq`). Groq is
  // already the workhorse and speaks the OpenAI-compatible API too, so it is
  // the one provider where the right answers are known in advance:
  //   openai/gpt-oss-120b        — in production for all four tasks. Must PASS.
  //   qwen/qwen3.6-27b           — documented in lib/llm/index.ts as unable to
  //                                hold json_schema. Must FAIL structured
  //                                output while still passing tool calling.
  // If those two ever come out the same way, this harness has stopped
  // measuring what it claims to and nothing it says about a new provider can
  // be trusted.
  {
    provider: "groq",
    envVar: "GROQ_API_KEY",
    baseURL: "https://api.groq.com/openai/v1",
    models: ["openai/gpt-oss-120b", "qwen/qwen3.6-27b"],
    console: "console.groq.com — already configured; calibration only",
    // The adapter lib/llm actually uses for groq, so the calibration reproduces
    // production rather than a compat-layer artifact.
    client: (apiKey) => createGroq({ apiKey }),
  },
];

// Providers probed only when named explicitly, so a bare run does not spend the
// production key's quota.
const CALIBRATION_ONLY = new Set(["groq"]);

const ATTEMPTS = 3;

// A resume with the shapes the real schema cares about: a job AND a project
// (the misclassification trap hardening exists for), a past graduation date
// (the isCurrentStudent trap), and unrelated freelance work that must NOT count
// toward yearsOfExperience.
const RESUME_TEXT = `PRIYA RAMANATHAN
Bengaluru, India | priya.r@example.com | +91 98765 43210

EDUCATION
B.E. Computer Science, RV College of Engineering — graduated May 2024

EXPERIENCE
Software Engineer, Zerodha (Aug 2024 - present)
  Built and shipped the order-reconciliation service handling 2M trades/day in Go.
  Cut end-of-day settlement time from 40 minutes to 6.
Backend Intern, Razorpay (Jan 2024 - Jun 2024)
  Payment webhook retry pipeline in Python; reduced duplicate webhook delivery by 94%.
Freelance video editor (2021 - 2022)
  Edited YouTube content for three creators. Unrelated to engineering.

PROJECTS
kvstore — a Raft-backed key-value store in Rust with a custom WAL. Rust, Tokio.
resume-rank — semantic search over job postings using pgvector and Cohere embeddings. Python, Postgres.

SKILLS
Go, Python, Rust, PostgreSQL, Kubernetes, gRPC, Redis`;

const RERANK_PROMPT = `You are a hiring consultant working the recruiter side for ONE candidate.

CANDIDATE
Name: Priya Ramanathan
Based in: Bengaluru, India
Years of professional experience: 1
Skills: Go, Python, Rust, PostgreSQL, Kubernetes, gRPC
Real experience — jobs/internships:
  - Software Engineer at Zerodha (Aug 2024 - present): order-reconciliation service, 2M trades/day, Go
  - Backend Intern at Razorpay (Jan 2024 - Jun 2024): payment webhook retry pipeline, Python
Projects:
  - kvstore [github]: Raft-backed key-value store in Rust (tech: Rust, Tokio)
  - resume-rank [github]: semantic search over job postings (tech: Python, Postgres, pgvector)

OPEN ROLES
[1] Backend Engineer @ Cashfree
  location: Bengaluru (remote) | team: 120 | source: greenhouse
  Building payment infrastructure in Go. You will own settlement and reconciliation services handling high transaction volume. 1-3 years experience.
[2] Senior Staff Distributed Systems Engineer @ Cockroach Labs
  location: New York | team: 300 | source: lever
  Lead the storage layer. 10+ years of experience with consensus protocols required.
[3] ML Infrastructure Engineer @ Sarvam AI
  location: Bengaluru | team: 40 | source: ashby
  Serving infrastructure for Indic language models. Python, Kubernetes, GPU scheduling.

TASK
Score EVERY role listed above, 0-100, on true-capability overlap, requirement and seniority match, location feasibility, and hiring-signal strength. Return all three. rationale must name a concrete piece of the candidate's proof-of-work. leadProof should cite real experience over projects when the candidate has relevant experience.`;

type Outcome = { ok: number; of: number; note: string; throttled: boolean };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A free-tier probe WILL hit rate limits — three attempts across three probes
// against an 8k-TPM key is more than a minute's budget. A 429 says nothing
// about whether the model can hold a schema, so it must never be scored as a
// capability failure: that would condemn a perfectly good provider on the
// strength of its own free tier. Wait it out, up to a point, then mark the run
// inconclusive rather than failed.
const QUOTA_RETRIES = 4;
const QUOTA_WAIT_MS = 20_000;

async function attempt<T>(run: () => Promise<T>): Promise<{ value?: T; err?: unknown; throttled?: true }> {
  for (let i = 0; ; i++) {
    try {
      return { value: await run() };
    } catch (err) {
      if (!looksLikeQuotaOrServerError(err)) return { err };
      if (i >= QUOTA_RETRIES) return { err, throttled: true };
      await sleep(QUOTA_WAIT_MS);
    }
  }
}

async function probeSchema(
  model: LanguageModel,
  schema: z.ZodTypeAny,
  prompt: string,
  validate: (v: unknown) => string | null,
): Promise<Outcome> {
  let ok = 0;
  let note = "";
  let throttled = false;
  for (let i = 0; i < ATTEMPTS; i++) {
    const r = await attempt(() => generateObject({ model, schema, prompt }));
    if (r.throttled) {
      throttled = true;
      note ||= "rate limited — inconclusive, re-run when the key is cool";
      continue;
    }
    if (r.err) {
      // First failure is the informative one; later ones are usually the same.
      note ||= (r.err instanceof Error ? r.err.message : String(r.err))
        .slice(0, 140)
        .replace(/\s+/g, " ");
      continue;
    }
    const problem = validate(r.value!.object);
    if (problem) {
      note ||= problem;
      continue;
    }
    ok++;
  }
  return { ok, of: ATTEMPTS, note, throttled };
}

// Structural validity is not enough — the Cerebras failure produced
// schema-shaped output with nothing in it. These check the model actually did
// the task.
function validateResume(v: unknown): string | null {
  const f = v as z.infer<typeof resumeFactsSchema>;
  if (!f?.experience?.length) return "no experience extracted";
  if (!f.skills?.length) return "no skills extracted";
  if (f.isCurrentStudent) return "isCurrentStudent true for a 2024 graduate";
  if (f.yearsOfExperience > 3) return `yearsOfExperience=${f.yearsOfExperience} (freelance miscounted?)`;
  return null;
}

function validateRerank(v: unknown): string | null {
  const r = v as z.infer<typeof rerankSchema>;
  if (!r?.matches?.length) return "no matches returned";
  if (r.matches.length !== 3) return `scored ${r.matches.length}/3 roles (must score all)`;
  const senior = r.matches.find((m) => m.jobIndex === 2);
  if (senior && senior.score > 60) return `scored the 10+ yrs senior role ${senior.score}`;
  return null;
}

// Tool calling is a different capability from structured output, and it is the
// one chatModelChain() needs. Cerebras passes structured output and rejects
// tool definitions outright with a 400, so this cannot be inferred.
async function probeTools(model: LanguageModel): Promise<Outcome> {
  let called = 0;
  let note = "";
  let throttled = false;
  for (let i = 0; i < ATTEMPTS; i++) {
    let hit = false;
    const r = await attempt(() =>
      generateText({
        model,
        system: "You help a candidate find jobs. Use the tools available to you.",
        prompt: "My name is Priya Ramanathan. Save it, then tell me you've got it.",
        tools: {
          saveProfile: tool({
            description: "Store the candidate's name the moment they give it.",
            // .nullable().optional() on the omittable fields, not .nullable()
            // alone — that exact mistake was a live 400 in production, because
            // .nullable() still leaves a field in the JSON Schema's `required`
            // list and the model correctly omits it. Probing with the wrong
            // shape would measure our bug instead of the provider's behaviour.
            inputSchema: z.object({
              name: z.string().nullable().optional(),
              githubUrl: z.string().nullable().optional(),
            }),
            execute: async () => {
              hit = true;
              return { saved: true };
            },
          }),
        },
        stopWhen: stepCountIs(3),
        maxRetries: 1,
      }),
    );
    if (r.throttled) {
      throttled = true;
      note ||= "rate limited — inconclusive, re-run when the key is cool";
      continue;
    }
    if (r.err) {
      note ||= (r.err instanceof Error ? r.err.message : String(r.err))
        .slice(0, 140)
        .replace(/\s+/g, " ");
      continue;
    }
    if (hit) called++;
    else note ||= "model never called the tool";
  }
  return { ok: called, of: ATTEMPTS, note, throttled };
}

const mark = (o: Outcome) =>
  `${o.ok}/${o.of}${o.ok === o.of ? " ok" : o.throttled ? " INCONCLUSIVE" : ""}`;

async function main() {
  const only = process.argv[2];
  const modelOverride = process.argv[3]?.split(",").map((s) => s.trim()).filter(Boolean);
  const wanted = only
    ? CANDIDATES.filter((c) => c.provider === only)
    : CANDIDATES.filter((c) => !CALIBRATION_ONLY.has(c.provider));
  if (wanted.length === 0) {
    throw new Error(`unknown provider "${only}". Known: ${CANDIDATES.map((c) => c.provider).join(", ")}`);
  }

  const missing = wanted.filter((c) => !process.env[c.envVar]);
  for (const c of missing) {
    console.log(`SKIP ${c.provider} — ${c.envVar} not set. Key from ${c.console}`);
  }
  const runnable = wanted.filter((c) => process.env[c.envVar]);
  if (runnable.length === 0) {
    console.log("\nNothing to probe. Set at least one of the keys above in .env and re-run.");
    return;
  }

  const verdicts: string[] = [];

  for (const c of runnable) {
    const client =
      c.client?.(process.env[c.envVar]!) ??
      createOpenAICompatible({
        name: c.provider,
        baseURL: c.baseURL,
        apiKey: process.env[c.envVar]!,
        supportsStructuredOutputs: true,
      });

    // Ad-hoc model list, so evaluating a replacement model does not mean
    // editing this file first.
    const models = modelOverride ?? c.models;
    for (const modelId of models) {
      console.log(`\n=== ${c.provider} / ${modelId} ===`);
      const model = client(modelId);

      const resume = await probeSchema(model, resumeFactsSchema, RESUME_TEXT_PROMPT(), validateResume);
      console.log(`  resumeExtraction  ${mark(resume)}${resume.note ? `  — ${resume.note}` : ""}`);

      const rerank = await probeSchema(model, rerankSchema, RERANK_PROMPT, validateRerank);
      console.log(`  rerank            ${mark(rerank)}${rerank.note ? `  — ${rerank.note}` : ""}`);

      const tools = await probeTools(model);
      console.log(`  toolCalling       ${mark(tools)}${tools.note ? `  — ${tools.note}` : ""}`);

      // Only a clean sweep qualifies. 2/3 is the score that broke production
      // last time — an intermittent schema failure reads as a quota problem to
      // the fail-over logic and silently degrades results.
      //
      // "inconclusive" is a third state on purpose. A throttled run is not a
      // pass and must not be read as one, but it is not evidence of a defect
      // either, and collapsing it into "fail" would retire a good provider for
      // being busy.
      const verdict = (o: Outcome[], label: string) =>
        o.every((x) => x.ok === ATTEMPTS)
          ? `OK for ${label}`
          : o.some((x) => x.throttled)
            ? `INCONCLUSIVE for ${label} (rate limited)`
            : `NOT usable for ${label}`;
      verdicts.push(
        `${c.provider}/${modelId}: ${verdict([resume, rerank], "extractStructured chains")}; ` +
          `${verdict([tools], "chatModelChain")}`,
      );
    }
  }

  console.log("\n=== verdicts ===");
  for (const v of verdicts) console.log(`  ${v}`);
  console.log(
    "\nA pass qualifies a model; it does not add it. Edit TASK_ROUTES / chatModelChain in\n" +
      "lib/llm/index.ts by hand, and add the key's env var to .env.example.",
  );
}

// Wrapped so the prompt reads the same way lib/profile/resume.ts builds it:
// instruction first, then the raw text in a fenced block.
function RESUME_TEXT_PROMPT(): string {
  return `Extract structured facts from this resume. Today's date is ${new Date().toISOString().slice(0, 10)}.

Resume text:
"""
${RESUME_TEXT}
"""`;
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
