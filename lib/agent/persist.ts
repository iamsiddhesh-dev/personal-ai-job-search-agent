// Phase 6 — persist a completed search as a `runs` row + one `matches` row per
// result, so each result carries a real matches.id that a draft can reference
// (db/schema.ts: drafts.matchId → matches.id → runs.id, the §6 data model).
//
// This is the decision the Phase-6 handoff flagged: rather than loosening
// `drafts` to point at a bare jobId, we persist the run/matches the schema was
// designed for. It also gives run history for free.

import { db } from "@/lib/db";
import { runs, matches } from "@/db/schema";
import type { RankedMatch } from "./match";

// Insert the run and its matches, and return the results with `matchId` filled
// in. Best-effort: results is small (≤25) and this is a single run insert plus
// one bulk matches insert.
export async function persistRun(params: {
  userId: string;
  profileId: string;
  roleFocus: string;
  filters: unknown;
  results: RankedMatch[];
}): Promise<RankedMatch[]> {
  const { userId, profileId, roleFocus, filters, results } = params;
  if (results.length === 0) return results;

  const [run] = await db
    .insert(runs)
    .values({ userId, profileId, roleFocus, filters: filters as object })
    .returning({ id: runs.id });

  const inserted = await db
    .insert(matches)
    .values(
      results.map((r) => ({
        runId: run.id,
        jobId: r.jobId,
        score: r.score,
        breakdown: { vectorScore: r.vectorScore, hiringSignal: r.hiringSignal },
        leadProof: r.leadProof,
        leadProofType: r.leadProofType,
        standoutProject: r.standoutProject,
        gaps: r.gaps,
        rationale: r.rationale,
      })),
    )
    .returning({ id: matches.id, jobId: matches.jobId });

  // Map each match id back onto its result by jobId (each result is a distinct
  // job, so jobId is a safe key within one run).
  const byJob = new Map(inserted.map((m) => [m.jobId, m.id]));
  return results.map((r) => ({ ...r, matchId: byJob.get(r.jobId) ?? null }));
}
