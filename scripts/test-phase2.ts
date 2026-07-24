// Phase 2 exit test: real resume + GitHub -> accurate profile, zero invented
// claims. Judge the printed facts/playback by eye against the actual resume —
// this can't be fully automated, only "did we invent anything" can be checked.
//
// Needs: jobagent/tests/fixtures/resume.pdf (gitignored, not committed) and a
// GITHUB_USERNAME env var (or edit the constant below).
//
// Run: node --env-file=.env node_modules/tsx/dist/cli.mjs scripts/test-phase2.ts

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { parseResume } from "@/lib/profile/resume";
import { fetchGithubProfile } from "@/lib/profile/github";
import { mergeProfile } from "@/lib/profile/merge";

const FIXTURE_PATH = path.join(process.cwd(), "tests/fixtures/resume.pdf");
const GITHUB_USERNAME = process.env.GITHUB_USERNAME || "iamsiddhesh-dev";

async function main() {
  if (!existsSync(FIXTURE_PATH)) {
    console.error(`Missing fixture: ${FIXTURE_PATH}`);
    console.error("Drop a real resume PDF there (gitignored) before running this test.");
    process.exit(1);
  }

  const bytes = new Uint8Array(await readFile(FIXTURE_PATH));
  console.log("--- Parsing resume ---");
  const { text, facts } = await parseResume(bytes);
  console.log(`Extracted ${text.length} chars of resume text.`);
  console.log(JSON.stringify(facts, null, 2));

  console.log(`\n--- Fetching GitHub profile: ${GITHUB_USERNAME} ---`);
  const github = await fetchGithubProfile(GITHUB_USERNAME);
  console.log(JSON.stringify(github, null, 2));

  console.log("\n--- Merging profile ---");
  const merged = await mergeProfile({ resumeFacts: facts, github, linkedinText: null, portfolioUrl: null });
  console.log(`Skills (${merged.skills.length}):`, merged.skills.join(", "));
  console.log(`Projects (${merged.projects.length}):`);
  for (const p of merged.projects) console.log(`  - [${p.source}] ${p.name}: ${p.description}`);
  console.log(`Seniority: ${merged.seniority}`);
  console.log(`Embedding dims: ${merged.embedding.length}`);
  console.log(`\nPlayback:\n${merged.playback}`);

  console.log(
    "\nManual check: read the facts/playback above against the actual resume — every claim must trace back to it, nothing invented.",
  );
  console.log("\nPHASE 2 EXIT TEST: ran end-to-end. Confirm accuracy by eye before marking done.");
  process.exit(0);
}

main().catch((e) => {
  console.error("PHASE 2 EXIT TEST: FAILED");
  console.error(e);
  process.exit(1);
});
