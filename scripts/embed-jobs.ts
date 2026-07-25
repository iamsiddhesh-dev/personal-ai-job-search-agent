// Offline job-embedding backfill. This is where embedding lives now — NOT in
// the live match request. It runs in GitHub Actions, so a user search never
// waits on embedding. Uses Voyage AI (see lib/llm).
//
// Voyage's free (no-payment-method) tier is 3 requests/min and 10,000 tokens/min.
// To stay comfortably INSIDE that without ever tripping it, this script:
//   • packs each request up to a token budget well under 10K TPM (token-aware
//     batching — a fixed job count would blow the limit on long descriptions), and
//   • sends ONE request per minute (well under 3 RPM).
// That's ~15-20 jobs/min → the full ~15k corpus warms in ~12-16h, unattended.
// The India/remote engineering subset is embedded first (priority ordering), so
// searches are useful within the first couple of hours.
//
// Idempotent/resumable: only touches jobs where embedding IS NULL, so each run
// resumes where the last stopped and later runs pick up newly-harvested jobs.
//
// Run:  npm run embed-jobs
// Env:  EMBED_MAX          cap jobs embedded this run (default: all NULL)
//       VOYAGE_TPM_BUDGET  max tokens per request (default 8000; keep < 10000)
//       EMBED_BATCH        hard cap on texts per request (default 64)
//       EMBED_PAUSE        seconds between requests (default 60; keeps us < 3 RPM)
//       EMBED_BUDGET_MIN   stop cleanly after N minutes (Actions 6h-cap guard)

import { db } from "@/lib/db";
import { jobs, companies } from "@/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { embedTexts } from "@/lib/llm";
import { jobEmbeddingText } from "@/lib/agent/match";

const TPM_BUDGET = Number(process.env.VOYAGE_TPM_BUDGET ?? 8000);
const MAX_BATCH = Number(process.env.EMBED_BATCH ?? 64);
const PAUSE_MS = Number(process.env.EMBED_PAUSE ?? 60) * 1000;
const MAX = process.env.EMBED_MAX ? Number(process.env.EMBED_MAX) : Infinity;
const BUDGET_MS = process.env.EMBED_BUDGET_MIN ? Number(process.env.EMBED_BUDGET_MIN) * 60_000 : Infinity;
const startedAt = Date.now();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Rough token estimate (~4 chars/token for English) plus a small per-text
// overhead. Only used to keep each request under the TPM budget — it's a ceiling
// guard, so a slight overestimate is fine (and safer than an underestimate).
const estTokens = (text: string) => Math.ceil(text.length / 4) + 8;

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
  console.log(
    `embedding up to ${limit} this run (<= ${TPM_BUDGET} tok/req, <= ${MAX_BATCH} texts/req, 1 req / ${PAUSE_MS / 1000}s)`,
  );

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
  let cursor = 0;
  let rateLimited = false;
  while (cursor < items.length) {
    // Pack the next request up to the token budget (and the count cap).
    const batch: { jobId: string; text: string }[] = [];
    let tok = 0;
    while (cursor < items.length && batch.length < MAX_BATCH) {
      const t = estTokens(items[cursor].text);
      if (batch.length > 0 && tok + t > TPM_BUDGET) break; // always send at least one
      batch.push(items[cursor]);
      tok += t;
      cursor++;
    }

    // Embed this batch, tolerating rate limits: on a 429 (e.g. two runs landing
    // back-to-back so a prior request is still inside the rolling minute), wait
    // a full minute and retry the SAME batch rather than abandoning the run.
    // Only give up after several minutes of persistent limiting (or the time
    // budget), which the next scheduled run then resumes from.
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
        console.log(`  rate-limited — waiting 65s, then retrying this batch (attempt ${attempt + 1}/5)`);
        await sleep(65_000);
      }
    }
    if (vecs === null) break; // gave up (persistent limit or over budget)

    for (let k = 0; k < batch.length; k++) {
      await db.update(jobs).set({ embedding: vecs[k] }).where(eq(jobs.id, batch[k].jobId));
    }
    done += batch.length;
    console.log(`  embedded ${done}/${items.length}  (this req: ${batch.length} jobs, ~${tok} tok)`);

    if (cursor < items.length) {
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
