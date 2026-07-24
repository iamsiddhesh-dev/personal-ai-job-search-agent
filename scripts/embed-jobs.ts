// Offline job-embedding backfill. This is where embedding lives now — NOT in
// the live match request. It runs in the harvester (GitHub Actions, unlimited
// minutes), so a user search never waits on the embedding rate limit. Same
// premium Gemini model as before => zero quality change, just moved off the
// hot path.
//
// Idempotent/resumable: only touches jobs where embedding IS NULL, so it can be
// re-run nightly and only ever embeds newly-harvested jobs. Paced to respect
// the ~100-unit/min free-tier embedding quota (embedTexts also retries on 429).
//
// Run:  npm run embed-jobs
// Env:  EMBED_MAX    cap jobs embedded this run (default: all NULL)
//       EMBED_BATCH  texts per request (default 45; keep < ~90)
//       EMBED_PAUSE  seconds between batches (default 61)

import { db } from "@/lib/db";
import { jobs, companies } from "@/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { embedTexts } from "@/lib/llm";
import { jobEmbeddingText } from "@/lib/agent/match";

const BATCH = Number(process.env.EMBED_BATCH ?? 45);
const PAUSE_MS = Number(process.env.EMBED_PAUSE ?? 61) * 1000;
const MAX = process.env.EMBED_MAX ? Number(process.env.EMBED_MAX) : Infinity;
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
  console.log(`embedding up to ${limit} this run (batch ${BATCH}, pause ${PAUSE_MS / 1000}s)`);

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

  let done = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const vecs = await embedTexts(batch.map(jobEmbeddingText));
    for (let k = 0; k < batch.length; k++) {
      await db.update(jobs).set({ embedding: vecs[k] }).where(eq(jobs.id, batch[k].jobId));
    }
    done += batch.length;
    console.log(`  embedded ${done}/${rows.length}`);
    if (done < rows.length) {
      console.log(`  pausing ${PAUSE_MS / 1000}s (embedding rate limit)…`);
      await sleep(PAUSE_MS);
    }
  }

  const [{ left }] = await db
    .select({ left: sql<number>`count(*)::int` })
    .from(jobs)
    .where(and(eq(jobs.isActive, true), isNull(jobs.embedding)));
  console.log(`done. ${done} embedded this run; ${left} still remaining.`);
  process.exit(0);
}

main().catch((e) => {
  console.error("EMBED-JOBS FAILED");
  console.error(e);
  process.exit(1);
});
