// DB-backed cache for extractStructured, keyed on (task, sha256 of the exact
// prompt). Deliberately dumb — the prompt string already fully encodes the
// inputs (resume text, or profile+job-batch text for a rerank call), so two
// identical prompts are two identical questions and deserve the same answer
// without spending another API call on it.
//
// Why this exists instead of more API keys: free-tier providers' ToS is
// one-account-per-person, and a same-machine multi-account signup pattern is
// exactly what triggers a ban — a risk not worth taking pre-revenue. Making a
// single key's quota go further is the safe lever.

import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { llmCache } from "@/db/schema";
import { and, eq, gt, sql } from "drizzle-orm";
import type { LlmTask } from "./index";

// How long each task's answers stay trustworthy. These used to be two private
// constants in the two files that call extractStructured() with a cacheTtlMs —
// which was fine while the TTL was only ever enforced on READ, and became a
// correctness problem the moment scripts/sweep-llm-cache.ts started deleting
// rows: a sweep that guesses a cutoff either destroys rows a caller can still
// read, or leaves rows nobody can. Both readers and the sweep now take their
// cutoff from here, so the two can never disagree.
//
// Type-only import above, so this file stays free of a runtime cycle with
// ./index (which imports readCache/writeCache from here).
//
// `draftGeneration` is deliberately absent: it passes no cacheTtlMs at all,
// because its correction-retry loop builds a different prompt every call and a
// cache would never hit. The sweep treats any task missing from this map as
// uncached and uses the longest cutoff here, so an unrecognised row is aged out
// eventually but never deleted while something might still want it.
export const CACHE_TTL_MS = {
  // A given resume's text never changes, so a re-upload of the same file (or a
  // re-parse triggered by some other flow) is the exact same question asked
  // twice — cache it near-indefinitely rather than re-spending a free-tier call
  // on an answer that cannot have changed.
  resumeExtraction: 90 * 24 * 60 * 60 * 1000, // 90 days
  // Deterministic in its inputs (same resume text + same prior extraction ->
  // same check), so it caches on the same terms as extraction itself.
  hardening: 90 * 24 * 60 * 60 * 1000, // 90 days
  // Short relative to the resume tasks: the job pool underneath a batch shifts
  // as the harvester runs and postings close, so a stale score risks surfacing
  // a job that is no longer live.
  rerank: 6 * 60 * 60 * 1000, // 6 hours
} as const satisfies Partial<Record<LlmTask, number>>;

export function hashPrompt(task: string, prompt: string): string {
  return createHash("sha256").update(`${task}\n${prompt}`).digest("hex");
}

export async function readCache(task: string, prompt: string, ttlMs: number): Promise<unknown | null> {
  const hash = hashPrompt(task, prompt);
  const cutoff = new Date(Date.now() - ttlMs);
  const [row] = await db
    .select({ result: llmCache.result })
    .from(llmCache)
    .where(and(eq(llmCache.task, task), eq(llmCache.promptHash, hash), gt(llmCache.createdAt, cutoff)))
    .limit(1);
  return row ? row.result : null;
}

export async function writeCache(task: string, prompt: string, result: unknown): Promise<void> {
  const hash = hashPrompt(task, prompt);
  // Upsert: a re-computed answer for the same question (e.g. after a TTL miss)
  // should replace the stale row, not collide with the unique constraint.
  await db
    .insert(llmCache)
    .values({ task, promptHash: hash, result: result as object })
    .onConflictDoUpdate({
      target: [llmCache.task, llmCache.promptHash],
      set: { result: result as object, createdAt: sql`now()` },
    });
}
