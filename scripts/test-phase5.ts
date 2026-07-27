// Phase 5 exit test (REVISED-PLAN §8): "mark one applied → it's gone from
// the next /api/run search, and it resurfaces (somewhere visible) on its
// follow-up date." Exercises the exact functions app/api/run/route.ts and
// app/api/applications/route.ts call — same code path as the real app, just
// invoked directly instead of over HTTP (same approach as test-phase3.ts).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { parseResume } from "@/lib/profile/resume";
import { fetchGithubProfile } from "@/lib/profile/github";
import { mergeProfile } from "@/lib/profile/merge";
import { runMatch, type MatchProfile } from "@/lib/agent/match";
import { getOrCreateSingleUser } from "@/lib/user";
import { markApplied, getExcludedJobIds, listDueFollowups, listApplications, bumpSent } from "@/lib/applications";

const GITHUB_HANDLE = "iamsiddhesh-dev";
const FIXTURE = join(process.cwd(), "tests", "fixtures", "resume.pdf");

async function main() {
  console.log("=== Building real profile (fixture resume + GitHub) ===");
  const bytes = new Uint8Array(readFileSync(FIXTURE));
  const { facts } = await parseResume(bytes, "pdf");
  const github = await fetchGithubProfile(GITHUB_HANDLE);
  const merged = await mergeProfile({ resumeFacts: facts, github });
  const profile: MatchProfile = {
    name: merged.name,
    seniority: merged.seniority,
    yearsExperience: facts.yearsOfExperience,
    location: facts.location,
    skills: merged.skills,
    projects: merged.projects,
    experience: facts.experience,
    embedding: merged.embedding,
    summaryText: "",
  };

  const userId = await getOrCreateSingleUser();
  const searchOpts = { roleFocus: "any", locationPref: "anywhere" as const, teamSizeBucket: "any" as const };

  console.log("\n=== Search #1 (baseline, no exclusions) ===");
  const before = await runMatch(profile, { ...searchOpts, maxResults: 10, verifyLinks: false, log: console.log });
  if (before.length === 0) throw new Error("Baseline search returned 0 results — nothing to test against.");
  const target = before[0];
  console.log(`Picked target: "${target.title}" @ ${target.company} (jobId=${target.jobId})`);

  // Guard against a leftover row from a prior crashed run polluting this one.
  await db.execute(sql`delete from applications where job_id = ${target.jobId}`);

  try {
    console.log("\n=== Marking it applied ===");
    const appId = await markApplied({ userId, jobId: target.jobId, companyName: target.company, roleTitle: target.title });
    const excluded = await getExcludedJobIds(userId);
    if (!excluded.includes(target.jobId)) throw new Error("FAIL: getExcludedJobIds does not include the marked job.");
    console.log("OK: job id present in getExcludedJobIds().");

    console.log("\n=== Search #2 (same query, now excluding the applied job) ===");
    const after = await runMatch(profile, {
      ...searchOpts,
      excludeJobIds: excluded,
      maxResults: 10,
      verifyLinks: false,
      log: console.log,
    });
    if (after.some((r) => r.jobId === target.jobId)) {
      throw new Error("FAIL: applied job still appears in a new search.");
    }
    console.log("OK: applied job is gone from the next search.");

    console.log("\n=== Simulating day 6 passing (force nextFollowupAt into the past) ===");
    await db.execute(sql`update applications set next_followup_at = now() - interval '1 hour' where id = ${appId}`);
    const due = await listDueFollowups(userId);
    const dueRow = due.find((a) => a.id === appId);
    if (!dueRow) throw new Error("FAIL: application did not resurface in listDueFollowups after its date passed.");
    if (dueRow.status !== "applied") {
      throw new Error(
        `FAIL: expected status to still be "applied" while surfaced (no reply-tracking exists — a human has to act), got "${dueRow.status}".`,
      );
    }
    console.log(`OK: resurfaced, status="${dueRow.status}" (still needs a human to send the bump).`);

    console.log("\n=== User confirms they sent bump #1 ===");
    await bumpSent(appId);
    const afterBump = (await listApplications(userId)).find((a) => a.id === appId)!;
    if (afterBump.status !== "followed_up_1") {
      throw new Error(`FAIL: expected status followed_up_1 after bumpSent, got "${afterBump.status}".`);
    }
    const nowDue = await listDueFollowups(userId);
    if (nowDue.some((a) => a.id === appId)) {
      throw new Error("FAIL: row should not be due again immediately after a bump (next date is day 14).");
    }
    console.log(
      `OK: status="${afterBump.status}", nextFollowupAt=${afterBump.nextFollowupAt?.toISOString()} (14 days out), no longer in the due list.`,
    );

    console.log("\n=== Tracker snapshot (imported xlsx rows + this test row) ===");
    const all = await listApplications(userId);
    console.log(`Total application rows: ${all.length}`);

    console.log("Done — Phase 5 exit test PASSED.");
  } finally {
    console.log("\n=== Cleaning up test row ===");
    await db.execute(sql`delete from applications where job_id = ${target.jobId}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("PHASE 5 TEST FAILED");
  console.error(e);
  process.exit(1);
});
