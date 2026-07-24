// Phase 3 exit test (REVISED-PLAN §8): build the real profile from the fixture
// resume + GitHub, run the matching engine, print 25 ranked jobs for a by-eye
// judgment — would Siddhesh actually apply, and are the rationales SPECIFIC?
//
// Run: npm run test:phase3            (defaults role=full-stack, loc=india)
//      npm run test:phase3 ai remote  (role, location override via argv)

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseResume } from "@/lib/profile/resume";
import { fetchGithubProfile } from "@/lib/profile/github";
import { mergeProfile } from "@/lib/profile/merge";
import { runMatch, type MatchProfile, type LocationPref } from "@/lib/agent/match";

const GITHUB_HANDLE = "iamsiddhesh-dev";
const FIXTURE = join(process.cwd(), "tests", "fixtures", "resume.pdf");

function buildSummaryText(
  facts: Awaited<ReturnType<typeof parseResume>>["facts"],
): string {
  const parts: string[] = [];
  for (const e of facts.experience) {
    parts.push(`Experience: ${e.title} at ${e.company}${e.duration ? ` (${e.duration})` : ""} — ${e.summary}`);
  }
  for (const ed of facts.education) {
    parts.push(`Education: ${ed.degree}, ${ed.institution}${ed.graduationYear ? ` (${ed.graduationYear})` : ""}`);
  }
  return parts.join("\n");
}

async function main() {
  const roleFocus = process.argv[2] ?? "full-stack";
  const locationPref = (process.argv[3] ?? "india") as LocationPref;

  console.log(`\n=== Building profile from fixture + GitHub (${GITHUB_HANDLE}) ===`);
  const bytes = new Uint8Array(readFileSync(FIXTURE));
  const { facts } = await parseResume(bytes, "pdf");
  const github = await fetchGithubProfile(GITHUB_HANDLE);
  const merged = await mergeProfile({ resumeFacts: facts, github });
  console.log(`  name=${merged.name} seniority=${merged.seniority} skills=${merged.skills.length} projects=${merged.projects.length} embedding=${merged.embedding.length}d`);

  const profile: MatchProfile = {
    name: merged.name,
    seniority: merged.seniority,
    location: facts.location,
    skills: merged.skills,
    projects: merged.projects,
    embedding: merged.embedding,
    summaryText: buildSummaryText(facts),
  };

  console.log(`\n=== Running match (role='${roleFocus}', location='${locationPref}') ===`);
  const t0 = Date.now();
  const results = await runMatch(profile, {
    roleFocus,
    locationPref,
    teamSizeBucket: "any",
    finalLimit: 25,
    log: (m) => console.log(m),
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`\n=== ${results.length} RANKED JOBS (in ${secs}s) ===\n`);
  results.forEach((r, i) => {
    console.log(
      `${String(i + 1).padStart(2)}. [${r.score}] ${r.title} @ ${r.company}` +
        `  (${r.location ?? "n/a"}${r.isRemote ? ", remote" : ""} · team ${r.teamSize ?? "?"} · ${r.ycBatch ?? "—"} · cos ${r.vectorScore.toFixed(2)} · ${r.hiringSignal})`,
    );
    console.log(`    lead: ${r.leadProject}`);
    if (r.gaps.length) console.log(`    gaps: ${r.gaps.join("; ")}`);
    console.log(`    why:  ${r.rationale}`);
    console.log(`    apply: ${r.applyUrl ?? "n/a"}`);
    console.log();
  });

  process.exit(0);
}

main().catch((e) => {
  console.error("PHASE 3 TEST FAILED");
  console.error(e);
  process.exit(1);
});
