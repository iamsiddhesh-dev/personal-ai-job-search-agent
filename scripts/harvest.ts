// Phase 1 harvester: builds the company + job universe.
//   1. refresh company universe (YC API + curated accelerator list)
//   2. resolve ATS per company (careers-page scan, slug-guess fallback)
//   3. pull jobs from each resolved ATS board
//   4. pull the Himalayas feed (supplement)
//   5. upsert everything into Postgres
//
// Run with: npm run harvest
// Env knobs (all optional, useful for local iteration):
//   HARVEST_MAX_PAGES   YC pages to fetch (default 300 = full universe)
//   HARVEST_CONCURRENCY ATS-resolution concurrency (default 16)
//   HARVEST_HIMALAYAS_PAGES  Himalayas pages, 20 jobs/page (default 25)

import { db } from "@/lib/db";
import { companies, jobs } from "@/db/schema";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { fetchYcCompanies } from "@/lib/sources/yc";
import { fetchSpeedrunCompanies } from "@/lib/sources/speedrun";
import { acceleratorCompanies } from "@/lib/sources/accelerators";
import { resolveAts } from "@/lib/sources/resolve-ats";
import { fetchJobs as fetchAtsJobs } from "@/lib/sources/ats";
import { fetchHimalayas } from "@/lib/sources/himalayas";
import { mapLimit } from "@/lib/sources/http";
import type { NormalizedJob, SourceCompany } from "@/lib/sources/types";

const MAX_PAGES = Number(process.env.HARVEST_MAX_PAGES ?? 300);
const CONCURRENCY = Number(process.env.HARVEST_CONCURRENCY ?? 16);
const HIMALAYAS_PAGES = Number(process.env.HARVEST_HIMALAYAS_PAGES ?? 25);

// Companies worth spending ATS-resolution requests on. Tiny/pre-team YC
// companies rarely have a job board yet (probe v1's mistake was not filtering
// this at all). No batch-year cutoff — unlike the probe, harvest.ts covers the
// whole active universe, not a sample.
function isHarvestCandidate(c: SourceCompany): boolean {
  if (c.source === "curated") return true; // accelerator seeds are hand-picked
  return (c.teamSize ?? 0) >= 5 && !!c.website;
}

// `companies` has no unique constraint (see db/schema.ts), so upserting means
// look-up-then-insert rather than ON CONFLICT — an ON CONFLICT clause would
// never fire and every run would duplicate every company.
async function upsertCompany(c: SourceCompany): Promise<string> {
  const existing = c.website
    ? await db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.website, c.website))
        .limit(1)
    : await db
        .select({ id: companies.id })
        .from(companies)
        .where(eq(companies.name, c.name))
        .limit(1);

  if (existing[0]) return existing[0].id;

  const [inserted] = await db
    .insert(companies)
    .values({
      name: c.name,
      slug: c.slug,
      website: c.website,
      source: c.source,
      ycBatch: c.ycBatch,
      teamSize: c.teamSize,
      industries: c.industries,
      regions: c.regions,
    })
    .returning({ id: companies.id });
  return inserted.id;
}

async function markAtsStatus(
  companyId: string,
  status: "found" | "not_found" | "error",
  resolved?: { type: string; slug: string },
) {
  await db
    .update(companies)
    .set({
      atsType: resolved?.type ?? null,
      atsSlug: resolved?.slug ?? null,
      atsCheckedAt: new Date(),
      atsStatus: status,
    })
    .where(eq(companies.id, companyId));
}

async function upsertJobs(companyId: string, normalized: NormalizedJob[]) {
  if (normalized.length === 0) return 0;
  const now = new Date();
  let count = 0;
  for (const j of normalized) {
    await db
      .insert(jobs)
      .values({
        companyId,
        source: j.source,
        externalId: j.externalId,
        title: j.title,
        description: j.description,
        location: j.location,
        isRemote: j.isRemote,
        employmentType: j.employmentType,
        salaryMin: j.salaryMin,
        salaryMax: j.salaryMax,
        applyUrl: j.applyUrl,
        postedAt: j.postedAt,
        lastSeenAt: now,
        isActive: true,
        raw: j.raw,
      })
      .onConflictDoUpdate({
        target: [jobs.source, jobs.externalId],
        set: {
          title: j.title,
          description: j.description,
          location: j.location,
          isRemote: j.isRemote,
          employmentType: j.employmentType,
          salaryMin: j.salaryMin,
          salaryMax: j.salaryMax,
          applyUrl: j.applyUrl,
          postedAt: j.postedAt,
          lastSeenAt: now,
          isActive: true,
          raw: j.raw,
        },
      });
    count++;
  }
  return count;
}

// After a fresh pull of a company's ATS board, any job we previously stored for
// that company+source that is no longer on the board has been filled/closed —
// flip it to isActive=false so matching (which only queries isActive) stops
// surfacing it. Without this a job stays "active" forever once first seen.
async function markClosedJobs(
  companyId: string,
  source: string,
  seenExternalIds: string[],
): Promise<number> {
  const base = and(
    eq(jobs.companyId, companyId),
    eq(jobs.source, source),
    eq(jobs.isActive, true),
  );
  const where =
    seenExternalIds.length > 0
      ? and(base, notInArray(jobs.externalId, seenExternalIds))
      : base; // board is now empty → close everything we had for it
  const closed = await db
    .update(jobs)
    .set({ isActive: false })
    .where(where)
    .returning({ id: jobs.id });
  return closed.length;
}

async function main() {
  console.log("=== 1. YC company universe ===");
  const yc = await fetchYcCompanies({ maxPages: MAX_PAGES });
  console.log(`  fetched ${yc.length} YC companies`);

  const curated = acceleratorCompanies();
  console.log(`  + ${curated.length} curated accelerator companies`);

  const speedrun = await fetchSpeedrunCompanies();
  console.log(`  + ${speedrun.length} a16z Speedrun companies`);

  const active = yc.filter((c) => c.name && c.website);
  const universe = [...active, ...curated, ...speedrun];

  console.log("\n=== 2. Upserting company universe ===");
  const companyIds = new Map<string, { id: string; company: SourceCompany }>();
  let upserted = 0;
  await mapLimit(universe, 8, async (c) => {
    const id = await upsertCompany(c);
    companyIds.set(id, { id, company: c });
    upserted++;
    if (upserted % 500 === 0) console.log(`  ...${upserted}/${universe.length}`);
  });
  console.log(`  companies upserted: ${companyIds.size}`);

  console.log("\n=== 3. Resolving ATS + pulling jobs ===");
  const candidates = [...companyIds.values()].filter(({ company }) =>
    isHarvestCandidate(company),
  );
  console.log(`  candidates (team>=5 or curated): ${candidates.length}`);

  let resolved = 0;
  let jobsWritten = 0;
  let jobsClosed = 0;
  let done = 0;
  await mapLimit(candidates, CONCURRENCY, async ({ id, company }) => {
    try {
      const hit = await resolveAts(company);
      if (!hit) {
        await markAtsStatus(id, "not_found");
        return;
      }
      const normalized = await fetchAtsJobs(hit.type, hit.slug);
      if (normalized === null) {
        await markAtsStatus(id, "not_found");
        return;
      }
      await markAtsStatus(id, "found", hit);
      resolved++;
      const n = await upsertJobs(id, normalized);
      jobsWritten += n;
      // Reconcile: close any of this company's jobs (same ATS source) that are
      // no longer on the freshly-fetched board.
      jobsClosed += await markClosedJobs(
        id,
        hit.type,
        normalized.map((j) => j.externalId),
      );
    } catch (err) {
      await markAtsStatus(id, "error");
      console.error(`  error resolving ${company.name}:`, err);
    } finally {
      done++;
      if (done % 200 === 0) console.log(`  ...${done}/${candidates.length}`);
    }
  });
  console.log(`  ATS resolved: ${resolved}/${candidates.length}`);
  console.log(`  jobs written (ATS): ${jobsWritten}`);
  console.log(`  jobs closed (gone from board): ${jobsClosed}`);

  console.log("\n=== 4. Himalayas feed (supplement) ===");
  const himalayasEntries = await fetchHimalayas(HIMALAYAS_PAGES);
  console.log(`  pulled ${himalayasEntries.length} usable entries`);
  let himalayasJobs = 0;
  for (const { company, job } of himalayasEntries) {
    const id = await upsertCompany(company);
    himalayasJobs += await upsertJobs(id, [job]);
  }
  console.log(`  jobs written (Himalayas): ${himalayasJobs}`);

  console.log("\n=== Summary ===");
  const [{ companyCount }] = await db
    .select({ companyCount: sql<number>`count(*)::int` })
    .from(companies);
  const [{ jobCount }] = await db
    .select({ jobCount: sql<number>`count(*)::int` })
    .from(jobs);
  console.log(`  companies table: ${companyCount} rows`);
  console.log(`  jobs table: ${jobCount} rows`);

  process.exit(0);
}

main().catch((e) => {
  console.error("HARVEST FAILED");
  console.error(e);
  process.exit(1);
});
