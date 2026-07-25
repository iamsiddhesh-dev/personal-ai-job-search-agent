// One-time backfill: the 24 rows imported from Job-Search-Tracker.xlsx
// (scripts/import-tracker.ts) landed with jobId=null — they were company-level
// outreach notes, not tied to a specific harvested posting. This script tries
// to link each one to a REAL, currently-open, currently-live job posting so
// it becomes a first-class application (excluded from future searches,
// clickable apply link) instead of a free-text stub.
//
// Deliberately conservative — per explicit instruction, no fabricated links:
//   1. Company match must be unambiguous (name match, disambiguated by the
//      YC batch noted in the tracker's "(YC Sxx/Wxx)" suffix when present).
//   2. The company must have at least one currently `is_active` job.
//   3. If it has more than one, the candidate must have a clear role-keyword
//      overlap with the tracker's noted role — never an arbitrary pick out of
//      a large pool (e.g. a staffing platform with 800 open roles).
//   4. The candidate's apply URL is HEAD/GET-checked live, right now, before
//      linking — a stale-but-still-"active" row in our DB doesn't count.
// Anything that fails any of these stays unlinked and is reported, not guessed.

import { db } from "@/lib/db";
import { applications, companies, jobs } from "@/db/schema";
import { eq, isNull, and, ilike } from "drizzle-orm";
import { UA } from "@/lib/sources/http";

const STOPWORDS = new Set([
  "full",
  "stack",
  "fullstack",
  "ai",
  "ml",
  "eng",
  "engineer",
  "engineering",
  "engineers",
  "software",
  "developer",
  "the",
  "and",
  "of",
  "a",
  "in",
  "type",
  "agent",
]);

function cleanCompanyName(raw: string): { name: string; batch: string | null } {
  const m = raw.match(/\(YC\s+([A-Z]\d{2})\)/i);
  const batch = m ? m[1].toUpperCase() : null;
  const name = raw.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return { name, batch };
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

function roleOverlapScore(roleTitle: string, jobTitle: string): number {
  const roleTokens = new Set(tokenize(roleTitle));
  const jobTokens = new Set(tokenize(jobTitle));
  let score = 0;
  for (const t of roleTokens) if (jobTokens.has(t)) score++;
  return score;
}

async function isLinkLive(url: string): Promise<boolean> {
  const attempt = async (method: "HEAD" | "GET") => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(url, { method, redirect: "follow", headers: UA, signal: ctrl.signal });
      return res.status;
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    let status = await attempt("HEAD");
    if (status === 405 || status === 501) status = await attempt("GET");
    return status >= 200 && status < 400;
  } catch {
    return false; // can't verify it's live -> don't link it
  }
}

interface TrackerRow {
  id: string;
  companyName: string | null;
  roleTitle: string | null;
}

async function main() {
  const rows: TrackerRow[] = await db
    .select({ id: applications.id, companyName: applications.companyName, roleTitle: applications.roleTitle })
    .from(applications)
    .where(isNull(applications.jobId));

  console.log(`${rows.length} unlinked application row(s) to process.\n`);

  const outcomes: { row: TrackerRow; result: string }[] = [];

  for (const row of rows) {
    if (!row.companyName) {
      outcomes.push({ row, result: "SKIP — no company name on the row" });
      continue;
    }
    const { name, batch } = cleanCompanyName(row.companyName);

    let companyMatches = await db
      .select({ id: companies.id, name: companies.name, ycBatch: companies.ycBatch })
      .from(companies)
      .where(ilike(companies.name, `%${name}%`));

    if (companyMatches.length > 1 && batch) {
      const narrowed = companyMatches.filter((c) => c.ycBatch === batch);
      if (narrowed.length >= 1) companyMatches = narrowed;
    }

    if (companyMatches.length === 0) {
      outcomes.push({ row, result: `SKIP — no company match in our database for "${name}"` });
      continue;
    }
    if (companyMatches.length > 1) {
      outcomes.push({
        row,
        result: `SKIP — ambiguous company match for "${name}" (${companyMatches.map((c) => c.name).join(", ")}), no batch hint to disambiguate`,
      });
      continue;
    }

    const company = companyMatches[0];
    const activeJobs = await db
      .select({ id: jobs.id, title: jobs.title, applyUrl: jobs.applyUrl })
      .from(jobs)
      .where(and(eq(jobs.companyId, company.id), eq(jobs.isActive, true)));

    if (activeJobs.length === 0) {
      outcomes.push({ row, result: `SKIP — "${company.name}" matched, but has 0 currently open postings` });
      continue;
    }

    let candidate = activeJobs[0];
    if (activeJobs.length > 1) {
      const scored = activeJobs
        .map((j) => ({ job: j, score: roleOverlapScore(row.roleTitle ?? "", j.title) }))
        .sort((a, b) => b.score - a.score);
      if (scored[0].score < 1) {
        outcomes.push({
          row,
          result: `SKIP — "${company.name}" matched with ${activeJobs.length} open postings, but none clearly match role "${row.roleTitle}" — needs manual review`,
        });
        continue;
      }
      candidate = scored[0].job;
    }

    if (!candidate.applyUrl) {
      outcomes.push({ row, result: `SKIP — matched job "${candidate.title}" @ ${company.name} has no apply URL on file` });
      continue;
    }

    const live = await isLinkLive(candidate.applyUrl);
    if (!live) {
      outcomes.push({
        row,
        result: `SKIP — matched job "${candidate.title}" @ ${company.name} but its apply link did not verify live just now (${candidate.applyUrl})`,
      });
      continue;
    }

    await db.update(applications).set({ jobId: candidate.id }).where(eq(applications.id, row.id));
    outcomes.push({ row, result: `LINKED -> "${candidate.title}" @ ${company.name} (verified live: ${candidate.applyUrl})` });
  }

  console.log("=== Report ===");
  for (const o of outcomes) {
    console.log(`${o.row.companyName} — ${o.result}`);
  }
  const linked = outcomes.filter((o) => o.result.startsWith("LINKED")).length;
  console.log(`\n${linked} of ${rows.length} rows linked to a verified, currently-open posting.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
