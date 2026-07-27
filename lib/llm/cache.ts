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
