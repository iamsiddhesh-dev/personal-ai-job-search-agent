// Drops quota counter rows for days nobody will ever read again (Phase D.2).
//
// lib/usage/quota.ts only ever reads `current_date`, so every earlier row is
// dead the moment the day rolls over. This exists because `llm_cache` taught
// the lesson the expensive way: a table that only ever gets INSERTed into grows
// forever against a 500 MB free-tier database, and nobody notices until it
// matters.
//
// The retention is deliberately generous rather than one day. These rows are
// the only record of how much the site is actually being used, which is exactly
// what the next round of quota sizing needs — SCALE-PLAN's numbers were an
// estimate, and 90 days of real counts is how they stop being one. They are
// four small columns; keeping them is nearly free.
//
// Runs from .github/workflows/embed-jobs.yml alongside the other sweeps.

import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

const RETENTION_DAYS = Number(process.env.USAGE_RETENTION_DAYS ?? 90);

async function main() {
  if (!Number.isFinite(RETENTION_DAYS) || RETENTION_DAYS < 1) {
    throw new Error(
      `USAGE_RETENTION_DAYS must be a number >= 1, got ${process.env.USAGE_RETENTION_DAYS}.`,
    );
  }

  // `day < current_date - N` and never `<=`: today's row is live and deleting
  // it would hand whoever is mid-conversation a fresh allowance.
  const deleted = await db.execute(sql`
    DELETE FROM usage_counters
    WHERE day < current_date - make_interval(days => ${RETENTION_DAYS}::int)
    RETURNING user_id
  `);

  const [remaining] = await db.execute<{ n: number; days: number }>(sql`
    SELECT count(*)::int AS n, count(DISTINCT day)::int AS days FROM usage_counters
  `);

  console.log(
    `swept ${deleted.length} usage_counters row${deleted.length === 1 ? "" : "s"} ` +
      `older than ${RETENTION_DAYS} days; ${remaining.n} row(s) across ${remaining.days} day(s) remain.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
