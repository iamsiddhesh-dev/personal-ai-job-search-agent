// Phase 3 — the matching engine. Highest-leverage file in the system
// (REVISED-PLAN.md §8, §9): every result the user ever sees inherits its
// quality from here.
//
// Stages, in order:
//   1. Rule filter (SQL)  — role keywords, location/remote, team-size bucket,
//        is_active, exclude already-seen, AND a seniority/years gate so a
//        fresher is never shown "6+ years / Senior / Staff" roles (title
//        exclusion here; the JD "N+ years" parse is applied just after).
//   2. Vector rank (JS)   — cosine similarity, profile embedding vs each
//        candidate's PRE-COMPUTED job embedding -> top ~60. This stage NEVER
//        embeds at request time: job embeddings are backfilled offline by the
//        harvester (scripts/embed-jobs.ts), so a live search reads vectors and
//        waits on nothing. Using the same premium Gemini model offline means
//        zero quality loss and seconds, not minutes, of latency.
//   3. LLM re-rank        — scores those ~60 (in token-safe batches, see
//        RERANK_BATCH_SIZE) on true-capability overlap (real experience first,
//        projects second), requirement/seniority match, India location
//        feasibility and hiring-signal strength -> every job that scores above
//        a threshold is returned (not a fixed top-N) with leadProof/gaps/
//        rationale.
//   4. Link liveness      — HEAD-check the final apply URLs and drop any that
//        have gone dead since the last harvest (catches same-day closures).
//
// All LLM/embedding traffic goes through lib/llm (the one choke point).

import { db } from "@/lib/db";
import { jobs, companies } from "@/db/schema";
import { and, eq, or, ilike, sql, notInArray, type SQL } from "drizzle-orm";
import { extractStructured } from "@/lib/llm";
import { mapLimit, UA } from "@/lib/sources/http";
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

export interface MatchExperience {
  title: string;
  company: string;
  duration: string | null;
  summary: string;
}

export interface MatchProfile {
  name: string | null;
  seniority: string | null;
  // Relevant professional/technical years, as a NUMBER (0 for a fresher / new
  // grad). This is what gates out senior, high-YOE roles — GitHub can't measure
  // it, so it comes from the resume/LinkedIn, defaulting to 0 when unknown.
  yearsExperience: number;
  location: string | null;
  skills: string[];
  projects: MatchProject[];
  // Real jobs/internships, kept as a first-class structured field (not buried
  // in summaryText) so the LLM re-rank can weigh it as heavily as projects —
  // see the leadProof logic below, which prioritizes this over projects.
  experience: MatchExperience[];
  embedding: number[]; // 1024-dim (Voyage voyage-4), from profiles.embedding
  // Rich free-text the LLM re-rank reads (resume summary + experience). Kept
  // separate from `embedding` so the LLM sees prose, not a vector.
  summaryText: string;
}

export interface MatchOptions {
  roleFocus: string; // 'fde' | 'full-stack' | 'ai' | 'frontend' | 'backend' | free text
  locationPref: LocationPref;
  teamSizeBucket?: TeamSizeBucket;
  excludeJobIds?: string[]; // already-applied jobs (Phase 5 wires the tracker in)
  // Seniority gate. Defaults are derived from the candidate's yearsExperience,
  // but the chat can override them (e.g. a user deliberately targeting a stretch
  // level). maxYearsRequired = the most years a role may demand and still be
  // shown; dropSeniorTitles = exclude Senior/Staff/Lead/… titles outright.
  maxYearsRequired?: number;
  dropSeniorTitles?: boolean;
  candidateCap?: number; // ranking-pool ceiling; default 1500
  vectorTopK?: number; // hand-off size to the LLM; default 40 (5 batches of 8)
  // Selection is now score-threshold-based, not a fixed top-N: every candidate
  // the LLM scores >= minScore is returned (real fit, whatever the count),
  // relaxed to minScoreFallback if that's too sparse to be useful, capped at
  // maxResults so a search can't return an unreasonably huge list.
  minScore?: number; // default 70
  minScoreFallback?: number; // default 60; used only if minScore yields < minResultsBeforeFallback
  minResultsBeforeFallback?: number; // default 5
  maxResults?: number; // hard cap on returned results; default 40
  verifyLinks?: boolean; // live-check the final apply URLs; default true
  log?: (msg: string) => void;
}

export interface RankedMatch {
  // Set by the /api/run route after it persists the run's `matches` rows, so a
  // drafts request can point at a real matches.id (Phase 6). The matcher itself
  // leaves this undefined — it doesn't persist anything.
  matchId?: string | null;
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
  // What to lead with when reaching out. Real experience (a job/internship)
  // wins over a project whenever the candidate has relevant experience;
  // a project only leads when there's no relevant experience to cite.
  leadProof: string;
  leadProofType: "experience" | "project";
  // A specific project worth also calling out, ONLY when it meaningfully
  // strengthens the case beyond leadProof (e.g. leadProof is an internship,
  // but a project is an unusually strong, directly-relevant build). null
  // when there's nothing to add.
  standoutProject: string | null;
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

// "any"/"all"/empty means the user wants every kind of role surfaced, not just
// engineering — the title filter is skipped entirely in that case.
function isAnyRole(roleFocus: string): boolean {
  return ["any", "all", "anything", "", "everything"].includes(roleFocus.trim().toLowerCase());
}

function roleKeywords(roleFocus: string): string[] {
  const key = roleFocus.trim().toLowerCase();
  const preset = ROLE_KEYWORDS[key];
  if (preset) return preset;
  // Unknown role: search the raw phrase plus generic engineering terms so we
  // never return an empty pool just because the label wasn't in the table.
  return [key, "software engineer", "software developer", "engineer"];
}

// Titles that signal a role above an early-career candidate. Word-boundary
// matched so "sr" won't hit "SRE", "lead" won't hit "leadership", etc.
const SENIOR_TITLE_RX =
  "\\y(senior|sr|staff|principal|lead|director|head|vp|architect|distinguished|manager|mgr|iii|iv)\\y";

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

async function ruleFilter(opts: MatchOptions, dropSeniorTitles: boolean): Promise<Candidate[]> {
  // Skip the title filter entirely for an "any" role search (show all job types).
  const roleCond = isAnyRole(opts.roleFocus)
    ? undefined
    : or(...roleKeywords(opts.roleFocus).map((k) => ilike(jobs.title, `%${k}%`)));

  const conds: (SQL | undefined)[] = [
    eq(jobs.isActive, true),
    roleCond,
    locationCondition(opts.locationPref),
    teamSizeCondition(opts.teamSizeBucket),
  ];
  if (dropSeniorTitles) {
    conds.push(sql`${jobs.title} !~* '${sql.raw(SENIOR_TITLE_RX)}'`);
  }
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
    .limit(opts.candidateCap ?? 1500) as Promise<Candidate[]>;
}

// Parse the strictest "N years (of) experience" requirement out of a JD. Returns
// the required minimum years, or null if the JD states none. Only counts a
// number when it sits next to experience-ish context, so "founded 6 years ago"
// or "10 years of combined team experience" don't masquerade as a requirement.
export function requiredYears(description: string | null): number | null {
  if (!description) return null;
  const text = stripHtml(description).toLowerCase();
  let max: number | null = null;
  const re = /(\d{1,2})\s*\+?\s*(?:-\s*\d{1,2}\s*)?years?/g;
  for (const m of text.matchAll(re)) {
    const n = Number(m[1]);
    if (n < 1 || n > 20) continue;
    const idx = m.index ?? 0;
    const ctx = text.slice(Math.max(0, idx - 45), idx + m[0].length + 25);
    if (/experience|background|professional|industry|track record|hands-on|yoe/.test(ctx)) {
      max = Math.max(max ?? 0, n);
    }
  }
  return max;
}

// ---------------------------------------------------------------------------
// Shared text / vector helpers (jobEmbeddingText is exported so the offline
// backfill script builds byte-identical embedding input — no drift).
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

export function jobEmbeddingText(j: {
  title: string;
  companyName: string;
  location: string | null;
  teamSize: number | null;
  description: string | null;
}): string {
  const desc = j.description ? stripHtml(j.description).slice(0, 2000) : "";
  return `${j.title}\n${j.companyName} — ${j.location ?? "location n/a"} — team ${j.teamSize ?? "?"}\n${desc}`;
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

// ---------------------------------------------------------------------------
// Stage 2 — vector rank (reads pre-computed embeddings; never embeds here)
// ---------------------------------------------------------------------------

interface Ranked {
  cand: Candidate;
  vectorScore: number;
}

function vectorRank(
  profileEmbedding: number[],
  candidates: Candidate[],
  topK: number,
  log: (m: string) => void,
): Ranked[] {
  const ranked: Ranked[] = [];
  let notEmbedded = 0;
  for (const c of candidates) {
    const vec = toVec(c.embedding);
    if (!vec || vec.length === 0) {
      notEmbedded++;
      continue;
    }
    ranked.push({ cand: c, vectorScore: cosine(profileEmbedding, vec) });
  }
  if (notEmbedded > 0) {
    log(`  ${notEmbedded} candidate(s) not yet embedded — skipped (offline backfill covers them)`);
  }
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
      leadProof: z
        .string()
        .describe(
          "what to lead with for this role: if the candidate has a REAL job/internship relevant to this role, cite it (title at company) — real experience beats projects. Only cite a project here if the candidate has no relevant experience at all.",
        ),
      leadProofType: z
        .enum(["experience", "project"])
        .describe("'experience' if leadProof is a job/internship, 'project' if it's a project"),
      standoutProject: z
        .string()
        .nullable()
        .describe(
          "the exact name of ONE candidate project worth ALSO mentioning, ONLY if it meaningfully strengthens the case beyond leadProof (e.g. it's an unusually strong, directly-relevant build). null if there's nothing worth adding.",
        ),
      gaps: z
        .array(z.string())
        .describe("concrete skills/experience this specific role wants that the candidate is missing; [] if none"),
      rationale: z
        .string()
        .describe(
          "one or two specific sentences: what this company is building and the concrete experience/project/skill overlap that makes it a fit. No boilerplate.",
        ),
      hiringSignal: z
        .enum(["verified", "inferred"])
        .describe("'verified' = a real open posting; 'inferred' = guessed from stage/size"),
    }),
  ),
});

function profileBlock(profile: MatchProfile): string {
  const experience = profile.experience
    .map(
      (e) =>
        `  - ${e.title} at ${e.company}${e.duration ? ` (${e.duration})` : ""}: ${e.summary}`,
    )
    .join("\n");
  const projects = profile.projects
    .map((p) => `  - ${p.name} [${p.source}]: ${p.description} (tech: ${p.technologies.join(", ") || "n/a"})`)
    .join("\n");
  return [
    `Name: ${profile.name ?? "unknown"}`,
    `Based in: ${profile.location ?? "India (assume India)"}`,
    `Years of professional experience: ${profile.yearsExperience}`,
    `Seniority: ${profile.seniority ?? "unstated — treat as early-career"}`,
    `Skills: ${profile.skills.join(", ") || "n/a"}`,
    `Real experience — jobs/internships (this is the STRONGEST proof of work; prioritize citing this when relevant):\n${experience || "  (none — this candidate has no professional experience yet, projects are their only proof of work)"}`,
    `Projects (secondary proof of work — cite when there's no relevant experience, or when a specific project is a standout that strengthens an experience-led case):\n${projects || "  (none)"}`,
    "",
    "Fuller background:",
    profile.summaryText,
  ].join("\n");
}

function jobsBlock(ranked: Ranked[]): string {
  return ranked
    .map((r, i) => {
      const c = r.cand;
      const desc = c.description ? stripHtml(c.description).slice(0, JOB_DESC_CHARS) : "(no description)";
      const salary =
        c.salaryMin || c.salaryMax ? `\n  salary: ${c.salaryMin ?? "?"}–${c.salaryMax ?? "?"}` : "";
      return `[${i + 1}] ${c.title} @ ${c.companyName}\n  location: ${c.location ?? "n/a"}${
        c.isRemote ? " (remote)" : ""
      } | team: ${c.teamSize ?? "?"} | batch: ${c.ycBatch ?? "n/a"} | source: ${c.source}${salary}\n  ${desc}`;
    })
    .join("\n\n");
}

function rerankPrompt(profile: MatchProfile, ranked: Ranked[]): string {
  return `You are a hiring consultant working the recruiter side for ONE candidate. You are NOT a job board — rank by genuine fit, not company fame (REVISED-PLAN §10).

CANDIDATE
${profileBlock(profile)}

OPEN ROLES (already pre-filtered by role, seniority, location and vector similarity; each is a real live posting from a company's own applicant-tracking system):
${jobsBlock(ranked)}

TASK
Score EVERY role listed above, 0–100, on the weighted combination:
- True-capability overlap: does what this company builds line up with what the candidate has actually DONE? Real, relevant job/internship experience is the strongest signal — weigh it above projects whenever the candidate has any. Projects are the primary signal only when the candidate has no relevant experience; an unusually strong, directly-relevant project can also add to (not replace) an experience-led case. Reward concrete overlap ("they're building onboarding, he shipped onboarding flows at Acme"), not vague topical similarity.
- Requirement & seniority match: the candidate has ${profile.yearsExperience} years of professional experience. A role clearly wanting significantly more experience, or a senior/staff specialty, is a weak fit even if the domain matches — score it low and say so in gaps. Do not reward roles the candidate is plainly under-qualified for.
- Location feasibility for someone based in India: an onsite US/EU role is a poor fit unless it is genuinely remote-friendly to India. Reflect this in the score and call it out in gaps when relevant.
- Hiring-signal strength: all of these are verified live openings, so use "verified"; only use "inferred" if you are truly guessing.

RULES
- Score and return ALL roles listed above — do not omit any, do not pre-filter to a top N (a later step selects which ones to show).
- rationale MUST be specific to the actual company and a concrete piece of the candidate's proof-of-work. Never generic ("great fit for your skills"). If you cannot name a specific overlap, the score should be low.
- leadProof: if the candidate has real, relevant job/internship experience, cite it (title at company) — this is almost always the right choice when it exists. Only cite a project as leadProof when the candidate has no relevant experience at all.
- standoutProject: leave null unless a specific project genuinely adds something leadProof doesn't already cover — don't force one in just to fill the field.
- gaps are concrete and role-specific (a missing skill, missing years, a location mismatch). Empty array if genuinely none.
- Never invent a hiring signal or a requirement that isn't in the role text.`;
}

// ---------------------------------------------------------------------------
// Stage 4 — apply-link liveness (drop same-day closures)
// ---------------------------------------------------------------------------

async function linkIsDead(url: string): Promise<boolean> {
  const attempt = async (method: "HEAD" | "GET") => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 7000);
    try {
      const res = await fetch(url, { method, redirect: "follow", headers: UA, signal: ctrl.signal });
      return res.status;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    let status = await attempt("HEAD");
    if (status === 405 || status === 501) status = await attempt("GET"); // HEAD not allowed
    // Only treat a definitive "gone" as dead. A transient network/5xx blip
    // should not silently drop a real opening.
    return status === 404 || status === 410;
  } catch {
    return false; // timeout / DNS hiccup — keep it rather than false-drop
  }
}

async function verifyApplyLinks(matches: RankedMatch[], log: (m: string) => void): Promise<RankedMatch[]> {
  const flags = await mapLimit(matches, 8, async (m) =>
    m.applyUrl ? await linkIsDead(m.applyUrl) : false,
  );
  const kept = matches.filter((_, i) => !flags[i]);
  const dropped = matches.length - kept.length;
  if (dropped > 0) log(`  dropped ${dropped} result(s) with dead apply links`);
  return kept;
}

// Jobs per Stage-3 LLM call. Batching bounds prompt size per call so no single
// request can exceed a provider's per-request token ceiling.
//
// Sizing is measured, not guessed: the profile block plus instructions is a
// fixed ~1.2k tokens, and each job adds ~250 (its metadata plus a
// JOB_DESC_CHARS-capped description). The tightest ceiling we target is Groq's
// 8000 TPM, and a request must fit with room to spare because the limit is
// per-MINUTE, not per-request — concurrent batches share it.
//   15 jobs measured 8431 tokens and was rejected outright ("Request too large
//   … Limit 8000"). That was the original production crash.
//    8 jobs lands near ~3.2k, so two can be in flight and still fit.
const RERANK_BATCH_SIZE = 8;

// Characters of job description handed to the re-rank. The single biggest lever
// on prompt size; 700 was generous enough to push a batch over the limit.
const JOB_DESC_CHARS = 500;

// How many rerank batches may be in flight at once. Batching alone doesn't fix
// a TPM cap: firing every batch in parallel spends all their tokens inside the
// same minute, which is what the cap actually measures. Two in flight keeps a
// Groq-served rerank under 8k TPM and a Cerebras-served one under its 5
// requests/minute.
const RERANK_CONCURRENCY = 2;

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runMatch(profile: MatchProfile, opts: MatchOptions): Promise<RankedMatch[]> {
  const log = opts.log ?? (() => {});
  const minScore = opts.minScore ?? 70;
  const minScoreFallback = opts.minScoreFallback ?? 60;
  const minResultsBeforeFallback = opts.minResultsBeforeFallback ?? 5;
  const maxResults = opts.maxResults ?? 40;
  const topK = opts.vectorTopK ?? 40;

  // Seniority gate, derived from the candidate's years unless the caller overrode
  // it. A 0-year fresher gets maxYears=2 (so "3+ years" roles are dropped) and
  // senior-titled roles excluded outright.
  const maxYears = opts.maxYearsRequired ?? Math.max(2, profile.yearsExperience + 1);
  const dropSeniorTitles = opts.dropSeniorTitles ?? profile.yearsExperience <= 1;

  log("Stage 1 — rule filter");
  const raw = await ruleFilter(opts, dropSeniorTitles);
  // JD "N+ years" gate (needs the description text, so it runs in JS here).
  const candidates = raw.filter((c) => {
    const req = requiredYears(c.description);
    return req === null || req <= maxYears;
  });
  const yearsDropped = raw.length - candidates.length;
  log(
    `  ${candidates.length} candidates (role='${opts.roleFocus}', loc='${opts.locationPref}', team='${opts.teamSizeBucket ?? "any"}', maxYears=${maxYears}, seniorTitlesDropped=${dropSeniorTitles}; ${yearsDropped} dropped by JD years gate)`,
  );
  if (candidates.length === 0) return [];

  log("Stage 2 — vector rank");
  const ranked = vectorRank(profile.embedding, candidates, topK, log);
  log(
    `  top ${ranked.length} by cosine (best=${ranked[0]?.vectorScore.toFixed(3) ?? "n/a"}, worst=${ranked[ranked.length - 1]?.vectorScore.toFixed(3) ?? "n/a"})`,
  );
  if (ranked.length === 0) return [];

  log("Stage 3 — LLM re-rank");
  const batches = chunk(ranked, RERANK_BATCH_SIZE);
  const batchResults = await mapLimit(batches, RERANK_CONCURRENCY, (batch) =>
    extractStructured({
      task: "rerank",
      prompt: rerankPrompt(profile, batch),
      schema: rerankSchema,
    }),
  );
  log(`  LLM scored ${batches.length} batch(es) of up to ${RERANK_BATCH_SIZE} jobs each`);

  // Map each batch's 1-based indices back onto the overall `ranked` array,
  // dropping any out-of-range or duplicate index the model might hallucinate.
  const seen = new Set<number>();
  const scored: RankedMatch[] = [];
  batchResults.forEach(({ matches }, batchIdx) => {
    const offset = batchIdx * RERANK_BATCH_SIZE;
    const batchLen = batches[batchIdx].length;
    for (const m of matches) {
      const localIdx = m.jobIndex - 1;
      if (localIdx < 0 || localIdx >= batchLen) continue;
      const idx = offset + localIdx;
      if (seen.has(idx)) continue;
      seen.add(idx);
      const c = ranked[idx].cand;
      scored.push({
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
        leadProof: m.leadProof,
        leadProofType: m.leadProofType,
        standoutProject: m.standoutProject,
        gaps: m.gaps,
        rationale: m.rationale,
        hiringSignal: m.hiringSignal,
      });
    }
  });
  scored.sort((a, b) => b.score - a.score);

  // Threshold-based selection, not a fixed top-N: show whatever genuinely
  // scores >= minScore. If that's too sparse to be useful, relax once to
  // minScoreFallback; if still sparse, that's the honest result (the pool just
  // doesn't have many strong matches) — always capped at maxResults.
  let out = scored.filter((m) => m.score >= minScore);
  let usedThreshold = minScore;
  if (out.length < minResultsBeforeFallback) {
    out = scored.filter((m) => m.score >= minScoreFallback);
    usedThreshold = minScoreFallback;
  }
  log(`  ${out.length} match(es) >= ${usedThreshold} (of ${scored.length} scored)`);
  out = out.slice(0, maxResults);

  if (opts.verifyLinks ?? true) {
    log("Stage 4 — apply-link liveness check");
    out = await verifyApplyLinks(out, log);
  }
  return out;
}
