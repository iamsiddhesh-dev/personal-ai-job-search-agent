// Phase 3 — the matching engine. Highest-leverage file in the system
// (REVISED-PLAN.md §8, §9): every result the user ever sees inherits its
// quality from here. Three stages, in order:
//
//   1. Rule filter (SQL)  — role keywords, location/remote, team-size bucket,
//        is_active, exclude already-seen. Thousands -> a few hundred.
//   1b. Lexical pre-rank  — free token overlap of profile terms vs each job's
//        title+description, keep the top ~180. This is the cost guard §5 in
//        practice: the Gemini free-tier embedding quota is only ~100 req/min
//        (each text counts), so we never embed the whole rule-filtered pool —
//        we embed only the most lexically-promising slice of it.
//   2. Vector rank (JS)   — cosine similarity, profile embedding vs each
//        candidate's job embedding -> top ~60. Backfills job embeddings the
//        first time a job is seen (only newly-seen jobs on later runs, stored
//        so re-runs are free), paced to respect the per-minute quota.
//   3. LLM re-rank        — Gemini Flash scores those ~60 on product<->project
//        overlap, early-career friendliness, requirement match, hiring-signal
//        strength and (critically for an India-based user, §12) location
//        feasibility -> returns 20-25 with lead_project / gaps / rationale.
//
// All LLM/embedding traffic goes through lib/llm (the one choke point), never
// a second path.

import { db } from "@/lib/db";
import { jobs, companies } from "@/db/schema";
import { and, eq, or, ilike, sql, notInArray, type SQL } from "drizzle-orm";
import { embedTexts, extractStructured } from "@/lib/llm";
import { mapLimit } from "@/lib/sources/http";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type LocationPref = "india" | "remote" | "anywhere";
export type TeamSizeBucket = "lt10" | "10-50" | "50-200" | "any";

export interface MatchProject {
  name: string;
  description: string;
  technologies: string[];
  source: string;
}

export interface MatchProfile {
  name: string | null;
  seniority: string | null;
  location: string | null;
  skills: string[];
  projects: MatchProject[];
  embedding: number[]; // 3072-dim, from profiles.embedding
  // Rich free-text the LLM re-rank reads (resume summary + experience). Kept
  // separate from `embedding` so the LLM sees prose, not a vector.
  summaryText: string;
}

export interface MatchOptions {
  roleFocus: string; // 'fde' | 'full-stack' | 'ai' | 'frontend' | 'backend' | free text
  locationPref: LocationPref;
  teamSizeBucket?: TeamSizeBucket;
  excludeJobIds?: string[]; // already-applied jobs (Phase 5 wires the tracker in)
  candidateCap?: number; // rule-filter ceiling; default 1000
  embedCap?: number; // max jobs to embed per run (quota guard); default 180
  vectorTopK?: number; // hand-off size to the LLM; default 60
  finalLimit?: number; // final results; default 25
  log?: (msg: string) => void;
}

export interface RankedMatch {
  jobId: string;
  title: string;
  company: string;
  location: string | null;
  isRemote: boolean;
  applyUrl: string | null;
  teamSize: number | null;
  ycBatch: string | null;
  source: string;
  score: number; // 0-100, from the LLM
  vectorScore: number; // cosine, stage 2
  leadProject: string;
  gaps: string[];
  rationale: string;
  hiringSignal: "verified" | "inferred";
}

// ---------------------------------------------------------------------------
// Stage 1 — rule filter
// ---------------------------------------------------------------------------

// Title keywords per target role. Deliberately broad (recall over precision):
// this stage only narrows the pool, the LLM re-rank does the real judgment.
// Every list includes generic SWE terms so a role-focused search still surfaces
// plain "Software Engineer" openings.
const ROLE_KEYWORDS: Record<string, string[]> = {
  fde: [
    "forward deployed",
    "forward-deployed",
    "solutions engineer",
    "solution engineer",
    "implementation engineer",
    "deployment engineer",
    "field engineer",
    "sales engineer",
    "customer engineer",
    "applied engineer",
    "software engineer",
  ],
  "full-stack": [
    "full stack",
    "full-stack",
    "fullstack",
    "software engineer",
    "software developer",
    "product engineer",
    "web developer",
    "application engineer",
    "founding engineer",
    "sde",
  ],
  ai: [
    "ai engineer",
    "ml engineer",
    "machine learning",
    "applied ai",
    "applied ml",
    "llm",
    "nlp",
    "genai",
    "generative ai",
    "research engineer",
    "data scientist",
    "ai/ml",
    "software engineer",
  ],
  frontend: [
    "frontend",
    "front end",
    "front-end",
    "ui engineer",
    "react",
    "web developer",
    "product engineer",
    "software engineer",
  ],
  backend: [
    "backend",
    "back end",
    "back-end",
    "platform engineer",
    "infrastructure engineer",
    "api engineer",
    "systems engineer",
    "distributed systems",
    "software engineer",
  ],
};

function roleKeywords(roleFocus: string): string[] {
  const key = roleFocus.trim().toLowerCase();
  const preset = ROLE_KEYWORDS[key];
  if (preset) return preset;
  // Unknown role: search the raw phrase plus generic engineering terms so we
  // never return an empty pool just because the label wasn't in the table.
  return [key, "software engineer", "software developer", "engineer"];
}

// Free-text locations are messy ("San Francisco, CA", "Remote - USA",
// "World Wide - Remote", "Bengaluru"). Matching is done with Postgres ~* on the
// raw location string plus the is_remote flag.
const INDIA_RX =
  "india|bangalore|bengaluru|pune|mumbai|delhi|hyderabad|gurgaon|gurugram|noida|chennai|kolkata|ahmedabad|jaipur";
const GLOBAL_REMOTE_RX = "world ?wide|anywhere|globally|global remote|remote - global";

function locationCondition(pref: LocationPref): SQL | undefined {
  switch (pref) {
    case "anywhere":
      return undefined;
    case "remote":
      return sql`(${jobs.isRemote} = true OR ${jobs.location} ~* 'remote|${sql.raw(GLOBAL_REMOTE_RX)}')`;
    case "india":
      // India-based user (REVISED-PLAN §12 top risk): keep India-located roles
      // and any remote role (feasibility of a country-locked remote is left to
      // the LLM to flag), but drop US/EU *onsite* roles — a Pune user can't take
      // an SF-onsite job. That exclusion is exactly the point of this filter.
      return sql`(${jobs.location} ~* '${sql.raw(INDIA_RX)}' OR ${jobs.isRemote} = true OR ${jobs.location} ~* 'remote|${sql.raw(GLOBAL_REMOTE_RX)}')`;
  }
}

function teamSizeCondition(bucket: TeamSizeBucket | undefined): SQL | undefined {
  // NULL team size is always kept — 335 job-bearing companies have unknown team
  // size (many are exactly the early-stage ones we care about); excluding them
  // would throw away recall for no reason.
  switch (bucket) {
    case "lt10":
      return sql`(${companies.teamSize} IS NULL OR ${companies.teamSize} < 10)`;
    case "10-50":
      return sql`(${companies.teamSize} IS NULL OR (${companies.teamSize} >= 10 AND ${companies.teamSize} < 50))`;
    case "50-200":
      return sql`(${companies.teamSize} IS NULL OR (${companies.teamSize} >= 50 AND ${companies.teamSize} < 200))`;
    case "any":
    case undefined:
      return undefined;
  }
}

interface Candidate {
  jobId: string;
  title: string;
  description: string | null;
  location: string | null;
  isRemote: boolean;
  salaryMin: number | null;
  salaryMax: number | null;
  applyUrl: string | null;
  source: string;
  embedding: unknown;
  companyName: string;
  teamSize: number | null;
  ycBatch: string | null;
}

async function ruleFilter(opts: MatchOptions): Promise<Candidate[]> {
  const kws = roleKeywords(opts.roleFocus);
  const roleCond = or(...kws.map((k) => ilike(jobs.title, `%${k}%`)));

  const conds: (SQL | undefined)[] = [
    eq(jobs.isActive, true),
    roleCond,
    locationCondition(opts.locationPref),
    teamSizeCondition(opts.teamSizeBucket),
  ];
  if (opts.excludeJobIds && opts.excludeJobIds.length > 0) {
    conds.push(notInArray(jobs.id, opts.excludeJobIds));
  }

  return db
    .select({
      jobId: jobs.id,
      title: jobs.title,
      description: jobs.description,
      location: jobs.location,
      isRemote: jobs.isRemote,
      salaryMin: jobs.salaryMin,
      salaryMax: jobs.salaryMax,
      applyUrl: jobs.applyUrl,
      source: jobs.source,
      embedding: jobs.embedding,
      companyName: companies.name,
      teamSize: companies.teamSize,
      ycBatch: companies.ycBatch,
    })
    .from(jobs)
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .where(and(...conds.filter((c): c is SQL => c !== undefined)))
    // Prefer fresh roles when the cap bites.
    .orderBy(sql`${jobs.postedAt} desc nulls last`, sql`${jobs.lastSeenAt} desc`)
    .limit(opts.candidateCap ?? 1000) as Promise<Candidate[]>;
}

// ---------------------------------------------------------------------------
// Stage 1b — lexical pre-rank (free; bounds how much we embed)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  "the", "and", "for", "with", "you", "your", "our", "are", "will", "have", "this",
  "that", "from", "was", "were", "job", "role", "team", "work", "working", "engineer",
  "engineering", "software", "developer", "development", "experience", "years",
]);

function terms(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9+#. ]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

// A weighted bag of the candidate's distinguishing terms: skills, project names
// + tech + descriptions. Used only to decide which rule-filtered jobs are worth
// spending an embedding on — the real semantic ranking is stage 2.
function profileTerms(profile: MatchProfile): Map<string, number> {
  const bag = new Map<string, number>();
  const add = (s: string, w: number) => {
    for (const t of terms(s)) bag.set(t, (bag.get(t) ?? 0) + w);
  };
  for (const s of profile.skills) add(s, 3);
  for (const p of profile.projects) {
    add(p.name, 3);
    add(p.technologies.join(" "), 2);
    add(p.description, 1);
  }
  add(profile.summaryText, 1);
  return bag;
}

function lexicalPrefilter(
  profile: MatchProfile,
  candidates: Candidate[],
  keep: number,
): Candidate[] {
  if (candidates.length <= keep) return candidates;
  const bag = profileTerms(profile);
  const scored = candidates.map((c, i) => {
    const title = new Set(terms(c.title));
    const desc = new Set(c.description ? terms(stripHtml(c.description)) : []);
    let score = 0;
    for (const [term, w] of bag) {
      if (title.has(term)) score += w * 3; // a term hit in the title is worth 3x a body hit
      else if (desc.has(term)) score += w;
    }
    return { c, score, i };
  });
  // Sort by lexical score; ties fall back to the SQL order (recency).
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, keep).map((s) => s.c);
}

// ---------------------------------------------------------------------------
// Stage 2 — vector rank
// ---------------------------------------------------------------------------

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// pgvector comes back over the wire as a "[1,2,...]" string (or already an
// array depending on the driver path). Normalize either into number[].
function toVec(v: unknown): number[] | null {
  if (Array.isArray(v)) return v as number[];
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

function jobEmbeddingText(c: Candidate): string {
  const desc = c.description ? stripHtml(c.description).slice(0, 2000) : "";
  return `${c.title}\n${c.companyName} — ${c.location ?? "location n/a"} — team ${c.teamSize ?? "?"}\n${desc}`;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// Gemini free-tier embedding quota is ~100 embed_content units per rolling
// minute and each text in a batchEmbedContents call is one unit. Keep each
// batch comfortably under the cap (leaving headroom for units still aging out
// of the window from a prior batch) and wait a full minute between batches.
// embedTexts itself retries on a 429 as a safety net, but steady-state pacing
// should avoid hitting it at all. This backfill is paid once per job, ever.
const EMBED_BATCH = 45;
const EMBED_PAUSE_MS = 61_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Ranked {
  cand: Candidate;
  vec: number[];
  vectorScore: number;
}

async function vectorRank(
  profileEmbedding: number[],
  candidates: Candidate[],
  topK: number,
  log: (m: string) => void,
): Promise<Ranked[]> {
  // Split into "already embedded" vs "needs embedding" (first time we've seen
  // this job). Store freshly-computed embeddings back so future runs skip them.
  const withVec: { cand: Candidate; vec: number[] }[] = [];
  const missing: Candidate[] = [];
  for (const c of candidates) {
    const vec = toVec(c.embedding);
    if (vec && vec.length > 0) withVec.push({ cand: c, vec });
    else missing.push(c);
  }
  log(`  ${withVec.length} candidates already embedded, ${missing.length} to embed`);

  for (let i = 0; i < missing.length; i += EMBED_BATCH) {
    const batch = missing.slice(i, i + EMBED_BATCH);
    const vecs = await embedTexts(batch.map(jobEmbeddingText));
    // Persist back to jobs.embedding so this cost is paid once per job, ever.
    await mapLimit(batch, 8, async (c, idx) => {
      const vec = vecs[idx];
      withVec.push({ cand: c, vec });
      await db.update(jobs).set({ embedding: vec }).where(eq(jobs.id, c.jobId));
    });
    const done = Math.min(i + EMBED_BATCH, missing.length);
    log(`  embedded ${done}/${missing.length}`);
    if (done < missing.length) {
      log(`  pausing ${EMBED_PAUSE_MS / 1000}s for embedding rate limit…`);
      await sleep(EMBED_PAUSE_MS);
    }
  }

  const ranked: Ranked[] = withVec.map(({ cand, vec }) => ({
    cand,
    vec,
    vectorScore: cosine(profileEmbedding, vec),
  }));
  ranked.sort((a, b) => b.vectorScore - a.vectorScore);
  return ranked.slice(0, topK);
}

// ---------------------------------------------------------------------------
// Stage 3 — LLM re-rank
// ---------------------------------------------------------------------------

const rerankSchema = z.object({
  matches: z.array(
    z.object({
      jobIndex: z.number().int().describe("the 1-based index of the job from the list"),
      score: z.number().min(0).max(100),
      leadProject: z
        .string()
        .describe("the exact name of ONE of the candidate's real projects to lead with for this role"),
      gaps: z
        .array(z.string())
        .describe("concrete skills/experience this specific role wants that the candidate is missing; [] if none"),
      rationale: z
        .string()
        .describe(
          "one or two specific sentences: what this company is building and the concrete project/skill overlap that makes it a fit. No boilerplate.",
        ),
      hiringSignal: z
        .enum(["verified", "inferred"])
        .describe("'verified' = a real open posting; 'inferred' = guessed from stage/size"),
    }),
  ),
});

function profileBlock(profile: MatchProfile): string {
  const projects = profile.projects
    .map((p) => `  - ${p.name} [${p.source}]: ${p.description} (tech: ${p.technologies.join(", ") || "n/a"})`)
    .join("\n");
  return [
    `Name: ${profile.name ?? "unknown"}`,
    `Based in: ${profile.location ?? "India (assume India)"}`,
    `Seniority: ${profile.seniority ?? "unstated — treat as early-career"}`,
    `Skills: ${profile.skills.join(", ") || "n/a"}`,
    `Projects (proof of work):\n${projects || "  (none)"}`,
    "",
    "Fuller background:",
    profile.summaryText,
  ].join("\n");
}

function jobsBlock(ranked: Ranked[]): string {
  return ranked
    .map((r, i) => {
      const c = r.cand;
      const desc = c.description ? stripHtml(c.description).slice(0, 700) : "(no description)";
      const salary =
        c.salaryMin || c.salaryMax ? `\n  salary: ${c.salaryMin ?? "?"}–${c.salaryMax ?? "?"}` : "";
      return `[${i + 1}] ${c.title} @ ${c.companyName}\n  location: ${c.location ?? "n/a"}${
        c.isRemote ? " (remote)" : ""
      } | team: ${c.teamSize ?? "?"} | batch: ${c.ycBatch ?? "n/a"} | source: ${c.source}${salary}\n  ${desc}`;
    })
    .join("\n\n");
}

function rerankPrompt(profile: MatchProfile, ranked: Ranked[], finalLimit: number): string {
  return `You are a hiring consultant working the recruiter side for ONE candidate. You are NOT a job board — rank by genuine fit, not company fame (REVISED-PLAN §10).

CANDIDATE
${profileBlock(profile)}

OPEN ROLES (already pre-filtered by role, location and vector similarity; each is a real live posting from a company's own applicant-tracking system):
${jobsBlock(ranked)}

TASK
Score each role 0–100 on the weighted combination:
- Product ↔ project overlap: does what this company builds line up with something the candidate has actually built? This matters most. Reward concrete overlap ("they're building onboarding, he built an Onboarding Copilot"), not vague topical similarity.
- Early-career friendliness: the candidate is early-career. A role demanding 8+ years or a narrow senior specialty is a weak fit even if the domain matches.
- Requirement match: how many of the role's stated requirements does the candidate plausibly meet?
- Location feasibility for someone based in India: an onsite US/EU role is a poor fit unless it is genuinely remote-friendly to India. Reflect this in the score and call it out in gaps when relevant.
- Hiring-signal strength: all of these are verified live openings, so use "verified"; only use "inferred" if you are truly guessing.

RULES
- Return ONLY the best ${finalLimit} roles, sorted by score descending (highest first).
- rationale MUST be specific to the actual company and a concrete piece of the candidate's proof-of-work. Never generic ("great fit for your skills"). If you cannot name a specific overlap, the score should be low.
- leadProject MUST be the exact name of one of the candidate's real projects listed above.
- gaps are concrete and role-specific (a missing skill, missing years, a location mismatch). Empty array if genuinely none.
- Never invent a hiring signal or a requirement that isn't in the role text.`;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runMatch(profile: MatchProfile, opts: MatchOptions): Promise<RankedMatch[]> {
  const log = opts.log ?? (() => {});
  const finalLimit = opts.finalLimit ?? 25;
  const topK = opts.vectorTopK ?? 60;

  log("Stage 1 — rule filter");
  const candidates = await ruleFilter(opts);
  log(`  ${candidates.length} candidates after rule filter (role='${opts.roleFocus}', loc='${opts.locationPref}', team='${opts.teamSizeBucket ?? "any"}')`);
  if (candidates.length === 0) return [];

  log("Stage 1b — lexical pre-rank");
  const embedCap = opts.embedCap ?? 180;
  const shortlist = lexicalPrefilter(profile, candidates, embedCap);
  log(`  ${candidates.length} -> ${shortlist.length} to embed (cap ${embedCap})`);

  log("Stage 2 — vector rank");
  const ranked = await vectorRank(profile.embedding, shortlist, topK, log);
  log(`  top ${ranked.length} by cosine (best=${ranked[0]?.vectorScore.toFixed(3)}, worst=${ranked[ranked.length - 1]?.vectorScore.toFixed(3)})`);
  if (ranked.length === 0) return [];

  log("Stage 3 — LLM re-rank");
  const { matches } = await extractStructured({
    prompt: rerankPrompt(profile, ranked, finalLimit),
    schema: rerankSchema,
  });
  log(`  LLM returned ${matches.length} scored matches`);

  // Map the LLM's 1-based indices back onto the candidate rows, dropping any
  // out-of-range or duplicate index the model might hallucinate.
  const seen = new Set<number>();
  const out: RankedMatch[] = [];
  for (const m of matches) {
    const idx = m.jobIndex - 1;
    if (idx < 0 || idx >= ranked.length || seen.has(idx)) continue;
    seen.add(idx);
    const c = ranked[idx].cand;
    out.push({
      jobId: c.jobId,
      title: c.title,
      company: c.companyName,
      location: c.location,
      isRemote: c.isRemote,
      applyUrl: c.applyUrl,
      teamSize: c.teamSize,
      ycBatch: c.ycBatch,
      source: c.source,
      score: m.score,
      vectorScore: ranked[idx].vectorScore,
      leadProject: m.leadProject,
      gaps: m.gaps,
      rationale: m.rationale,
      hiringSignal: m.hiringSignal,
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, finalLimit);
}
