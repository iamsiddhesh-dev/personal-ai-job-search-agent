// Deletes llm_cache rows that no caller can read any more (SCALE-PLAN Phase
// D.5). The TTL on this table is enforced ONLY on read — readCache() filters on
// `created_at > now() - ttl` and nothing has ever deleted the rows that fail
// that test, so the table grows forever against a 500 MB free-tier database.
//
// THE CUTOFF IS PER TASK, NOT GLOBAL, and that is the whole design of this
// script. `llm_cache` mixes tasks with TTLs three orders of magnitude apart:
// `rerank` trusts a score for 6 hours, `resumeExtraction` and `hardening` trust
// theirs for 90 days. One global cutoff cannot be right for both — the short
// one silently destroys resume answers their caller would still have used
// (turning a cache hit back into a free-tier API call, which is the exact cost
// this table exists to avoid), and the long one leaves rerank garbage sitting
// for three months. Since `task` is stored on the row, there is no reason to
// guess: each task is aged out on its own number.
//
// Those numbers come from CACHE_TTL_MS in lib/llm/cache.ts, which is also what
// readCache's callers pass. Shared deliberately: a sweep with its own private
// copy of a TTL is a sweep that deletes the wrong rows the first time someone
// tunes one of them.
//
// A task NOT in that map — `draftGeneration`, which passes no cacheTtlMs at
// all, or anything a future phase adds and forgets to register — is aged out on
// the LONGEST cutoff in the map rather than the shortest. Being slow to delete
// an unrecognised row costs disk; being fast to delete one costs a free-tier
// API call and possibly a wrong answer, so the conservative direction is the
// cheap one.
//
// Runs from .github/workflows/embed-jobs.yml alongside the Phase C conversation
// sweep, for the same reasons: that workflow already runs every 6 hours against
// the same DATABASE_URL, and it exists partly to stop the Supabase project
// auto-pausing after 7 days idle. Idempotent and cheap — one statement.
//
// Note this reclaims space for REUSE, not for the filesystem: a DELETE leaves
// dead tuples behind until autovacuum collects them. That is fine here (the
// table is written constantly, so the freed space goes straight back into new
// rows) and is why there is no VACUUM FULL, which would take an exclusive lock
// on a table the live app reads on every search.

import { db } from "@/lib/db";
import { sql, type SQL } from "drizzle-orm";
import { CACHE_TTL_MS } from "@/lib/llm/cache";

// Test hook, mirroring ARCHIVE_RETENTION_DAYS in sweep-conversations.ts. When
// set, EVERY task is aged out on this one number instead of its own, which is
// the only practical way to watch the sweep delete a row that was seeded
// seconds ago (SCALE-PLAN's verification: "run the sweep against a seeded old
// row, confirm it's gone and a fresh row survives"). Must never be set in the
// workflow or on Vercel — it defeats the per-task design above, which is why
// the run prints a warning when it is active.
const OVERRIDE_SECONDS = process.env.LLM_CACHE_MAX_AGE_SECONDS;

async function main() {
  const ttls = Object.entries(CACHE_TTL_MS) as [string, number][];
  if (ttls.length === 0) {
    throw new Error("CACHE_TTL_MS is empty — refusing to sweep with no TTL to sweep against.");
  }
  const longestSeconds = Math.floor(Math.max(...ttls.map(([, ms]) => ms)) / 1000);

  let cutoffSeconds: SQL;
  if (OVERRIDE_SECONDS !== undefined) {
    const n = Number(OVERRIDE_SECONDS);
    if (!Number.isFinite(n) || n < 1) {
      throw new Error(
        `LLM_CACHE_MAX_AGE_SECONDS must be a number >= 1, got ${OVERRIDE_SECONDS}.`,
      );
    }
    console.warn(
      `WARNING — LLM_CACHE_MAX_AGE_SECONDS=${n} is set. Every task is being swept at ${n}s ` +
        `instead of its own TTL. This is a testing hook; unset it for real runs.`,
    );
    cutoffSeconds = sql`${Math.floor(n)}::int`;
  } else {
    // CASE over the stored task, one branch per registered TTL, falling through
    // to the longest for anything unregistered. Built from the map rather than
    // written out so adding a task to CACHE_TTL_MS is the only edit needed.
    const branches = ttls.map(
      ([task, ms]) => sql`WHEN ${task} THEN ${Math.floor(ms / 1000)}::int`,
    );
    cutoffSeconds = sql`CASE task ${sql.join(branches, sql` `)} ELSE ${longestSeconds}::int END`;
  }

  const deleted = await db.execute<{ task: string }>(sql`
    DELETE FROM llm_cache
    WHERE created_at < now() - make_interval(secs => ${cutoffSeconds})
    RETURNING task
  `);

  // Per-task breakdown, because the interesting failure here is silent and
  // one-sided: a cutoff wired to the wrong task shows up as one task's count
  // being wildly out of proportion, not as an error.
  const byTask = new Map<string, number>();
  for (const row of deleted) byTask.set(row.task, (byTask.get(row.task) ?? 0) + 1);

  const [remaining] = await db.execute<{ n: number; size: string }>(sql`
    SELECT count(*)::int AS n, pg_size_pretty(pg_total_relation_size('llm_cache')) AS size
    FROM llm_cache
  `);

  const breakdown =
    byTask.size === 0
      ? ""
      : ` (${[...byTask.entries()].map(([task, n]) => `${task}: ${n}`).join(", ")})`;

  console.log(
    `swept ${deleted.length} stale llm_cache row${deleted.length === 1 ? "" : "s"}${breakdown}; ` +
      `${remaining.n} row(s) left, table now ${remaining.size}.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
