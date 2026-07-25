// Offline job-embedding backfill. This is where embedding lives now — NOT in
// the live match request. It runs in GitHub Actions, so a user search never
// waits on embedding. Uses Voyage AI (see lib/llm).
//
// Cohere's free trial key allows 2,000 inputs/min (96 texts/request max). We
// send 96-text requests spaced a few seconds apart to stay well under that —
// ~1,400 inputs/min → the full ~15k corpus warms in ~12min, unattended. The
// India/remote engineering subset is embedded first (priority ordering).
//
// Idempotent/resumable: only touches jobs where embedding IS NULL, so each run
// resumes where the last stopped and later runs pick up newly-harvested jobs.
//
// Run:  npm run embed-jobs
// Env:  EMBED_MAX          cap jobs embedded this run (default: all NULL)
//       EMBED_BATCH        texts per request (default 96; Cohere's hard max)
//       EMBED_PAUSE        seconds between requests (default 4; keeps < 2000/min)
//       EMBED_BUDGET_MIN   stop cleanly after N minutes (Actions 6h-cap guard)

import { db } from "@/lib/db";
import { jobs, companies } from "@/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { embedTexts } from "@/lib/llm";
import { jobEmbeddingText } from "@/lib/agent/match";

const BATCH = Number(process.env.EMBED_BATCH ?? 96);
const PAUSE_MS = Number(process.env.EMBED_PAUSE ?? 4) * 1000;
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
    // SAME batch rather than abandoning the run. Only give up after several
    // retries (or the time budget); the next scheduled run resumes from there.
    let vecs: number[][] | null = null;
    for (let attempt = 0; attempt <= 5; attempt++) {
      try {
        vecs = await embedTexts(batch.map((b) => b.text));
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const isRate = /429|quota|rate.?limit|RESOURCE_EXHAUSTED/i.test(msg);
        if (!isRate) throw err;
        if (attempt >= 5 || Date.now() - startedAt > BUDGET_MS) {
          rateLimited = true;
          break;
        }
        console.log(`  rate-limited — waiting 30s, then retrying this batch (attempt ${attempt + 1}/5)`);
        await sleep(30_000);
      }
    }
    if (vecs === null) break; // gave up (persistent limit or over budget)

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
