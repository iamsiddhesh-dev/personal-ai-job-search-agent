// Offline job-embedding backfill. This is where embedding lives now — NOT in
// the live match request. It runs in GitHub Actions, so a user search never
// waits on embedding. Uses Voyage AI (see lib/llm).
//
// Cohere's docs claim 2,000 inputs/min for a trial key, but observed live
// behavior on this key is far slower and hits 429s well before that — so this
// runs CONSERVATIVELY paced (well under the documented limit) and leans on the
// retry-with-wait loop below as the real safety net, not the pacing alone. Fully
// unattended: on a persistent 429 it waits and retries the same batch for
// several minutes before giving up for this run; the next scheduled run (every
// 6h, see .github/workflows/embed-jobs.yml) resumes automatically from wherever
// it stopped. No manual trigger needed once this is on `main`.
//
// Idempotent/resumable: only touches jobs where embedding IS NULL, so each run
// resumes where the last stopped and later runs pick up newly-harvested jobs.
//
// Run:  npm run embed-jobs
// Env:  EMBED_MAX          cap jobs embedded this run (default: all NULL)
//       EMBED_BATCH        texts per request (default 48; Cohere's hard max is 96)
//       EMBED_PAUSE        seconds between requests (default 15)
//       EMBED_BUDGET_MIN   stop cleanly after N minutes (Actions 6h-cap guard)

import { db } from "@/lib/db";
import { jobs, companies } from "@/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { embedTexts } from "@/lib/llm";
import { jobEmbeddingText } from "@/lib/agent/match";

const BATCH = Number(process.env.EMBED_BATCH ?? 48);
const PAUSE_MS = Number(process.env.EMBED_PAUSE ?? 15) * 1000;
const MAX = process.env.EMBED_MAX ? Number(process.env.EMBED_MAX) : Infinity;
const BUDGET_MS = process.env.EMBED_BUDGET_MIN ? Number(process.env.EMBED_BUDGET_MIN) * 60_000 : Infinity;
const startedAt = Date.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [{ remaining }] = await db
    .select({ remaining: sql<number>`count(*)::int` })
    .from(jobs)
    .where(and(eq(jobs.isActive, true), isNull(jobs.embedding)));
  console.log(`jobs still needing an embedding: ${remaining}`);

  const limit = Math.min(remaining, MAX);
  if (limit === 0) {
    console.log("nothing to embed — corpus is fully warmed.");
    process.exit(0);
  }
  console.log(`embedding up to ${limit} this run (${BATCH} texts/req, 1 req / ${PAUSE_MS / 1000}s)`);

  // Priority: engineering-ish titles that are India/remote-relevant and recent
  // get embedded first, so searches are useful long before the whole corpus is
  // warmed. Everything else follows by recency.
  const rows = (await db
    .select({
      jobId: jobs.id,
      title: jobs.title,
      description: jobs.description,
      location: jobs.location,
      companyName: companies.name,
      teamSize: companies.teamSize,
    })
    .from(jobs)
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .where(and(eq(jobs.isActive, true), isNull(jobs.embedding)))
    .orderBy(
      sql`(case when ${jobs.title} ~* 'engineer|developer|software' then 0 else 1 end)`,
      sql`(case when ${jobs.isRemote} = true or ${jobs.location} ~* 'india|remote|world ?wide|anywhere' then 0 else 1 end)`,
      sql`${jobs.lastSeenAt} desc`,
    )
    .limit(limit)) as {
    jobId: string;
    title: string;
    description: string | null;
    location: string | null;
    companyName: string;
    teamSize: number | null;
  }[];

  const items = rows.map((r) => ({ jobId: r.jobId, text: jobEmbeddingText(r) }));

  let done = 0;
  let rateLimited = false;
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);

    // Embed this batch, tolerating rate limits: on a 429, wait and retry the
    // SAME batch rather than abandoning the run. This is fully unattended, so
    // keep retrying for as long as the time budget allows (not a small fixed
    // attempt count) — the observed real limit on this key is stricter than
    // documented, and patience here is what makes "no manual intervention"
    // actually true. If the budget runs out mid-retry, the next scheduled run
    // (every 6h) resumes automatically from wherever this one stopped.
    let vecs: number[][] | null = null;
    let attempt = 0;
    for (;;) {
      try {
        vecs = await embedTexts(batch.map((b) => b.text));
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isRate = /429|quota|rate.?limit|RESOURCE_EXHAUSTED/i.test(msg);
        if (!isRate) throw err;
        attempt++;
        if (Date.now() - startedAt > BUDGET_MS) {
          rateLimited = true;
          break;
        }
        console.log(`  rate-limited — waiting 30s, then retrying this batch (attempt ${attempt})`);
        await sleep(30_000);
      }
    }
    if (vecs === null) break; // gave up (only happens once the time budget is exhausted)

    for (let k = 0; k < batch.length; k++) {
      await db.update(jobs).set({ embedding: vecs[k] }).where(eq(jobs.id, batch[k].jobId));
    }
    done += batch.length;
    console.log(`  embedded ${done}/${items.length}`);

    if (i + BATCH < items.length) {
      if (Date.now() - startedAt > BUDGET_MS) {
        console.log("  time budget reached — stopping cleanly (a later run resumes).");
        break;
      }
      await sleep(PAUSE_MS);
    }
  }

  const [{ left }] = await db
    .select({ left: sql<number>`count(*)::int` })
    .from(jobs)
    .where(and(eq(jobs.isActive, true), isNull(jobs.embedding)));
  if (rateLimited) {
    console.log(`hit Voyage rate limit — ${done} embedded this run; ${left} remaining, resumes next run.`);
  } else {
    console.log(`done. ${done} embedded this run; ${left} still remaining.`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("EMBED-JOBS FAILED");
  console.error(e);
  process.exit(1);
});
