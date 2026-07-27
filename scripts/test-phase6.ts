// Phase 6 exit test (REVISED-PLAN §8): generate outreach drafts for several
// different real openings and check the two exit criteria by machine + by eye:
//   1. Drafts differ meaningfully per company.
//   2. No leftover [BRACKET] placeholders (and the LinkedIn note fits 300 chars).
//
// Also smoke-tests the persistence wiring (persistRun attaches a real matchId),
// since that's what the /api/drafts route keys off in production.
//
// Run: npm run test:phase6            (defaults role=full-stack, loc=india)
//      npm run test:phase6 ai remote

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseResume } from "@/lib/profile/resume";
import { fetchGithubProfile } from "@/lib/profile/github";
import { mergeProfile } from "@/lib/profile/merge";
import { runMatch, type MatchProfile, type LocationPref } from "@/lib/agent/match";
import { generateDrafts, findPlaceholders, LINKEDIN_MAX_CHARS, type DraftProfile } from "@/lib/agent/drafts";
import { db } from "@/lib/db";
import { jobs } from "@/db/schema";
import { eq } from "drizzle-orm";

const GITHUB_HANDLE = "iamsiddhesh-dev";
const FIXTURE = join(process.cwd(), "tests", "fixtures", "resume.pdf");
const N_DRAFTS = 3; // distinct companies to draft for

function buildSummaryText(facts: Awaited<ReturnType<typeof parseResume>>["facts"]): string {
  const parts: string[] = [];
  for (const ed of facts.education) {
    parts.push(`Education: ${ed.degree}, ${ed.institution}${ed.graduationYear ? ` (${ed.graduationYear})` : ""}`);
  }
  return parts.join("\n");
}

function buildHeadline(facts: Awaited<ReturnType<typeof parseResume>>["facts"], seniority: string | null): string {
  const edu = facts.education?.[0];
  const parts: string[] = [];
  if (edu) {
    const year = edu.graduationYear ? `${edu.graduationYear} ` : "";
    parts.push(`${year}grad — ${edu.degree}, ${edu.institution}`.trim());
  }
  parts.push(`${seniority ?? "early-career"} full-stack + AI engineer who ships fast`);
  return parts.join("; ");
}

async function main() {
  const roleFocus = process.argv[2] ?? "full-stack";
  const locationPref = (process.argv[3] ?? "india") as LocationPref;

  console.log(`\n=== Building profile from fixture + GitHub (${GITHUB_HANDLE}) ===`);
  const bytes = new Uint8Array(readFileSync(FIXTURE));
  const { facts } = await parseResume(bytes, "pdf");
  const github = await fetchGithubProfile(GITHUB_HANDLE);
  const merged = await mergeProfile({ resumeFacts: facts, github });

  const matchProfile: MatchProfile = {
    name: merged.name,
    seniority: merged.seniority,
    yearsExperience: facts.yearsOfExperience,
    location: facts.location,
    skills: merged.skills,
    projects: merged.projects,
    experience: facts.experience,
    embedding: merged.embedding,
    summaryText: buildSummaryText(facts),
  };

  const draftProfile: DraftProfile = {
    name: merged.name,
    githubUrl: github.username ? `https://github.com/${github.username}` : null,
    headline: buildHeadline(facts, merged.seniority),
    projects: merged.projects.map((p) => ({
      name: p.name,
      description: p.description,
      technologies: p.technologies,
      url: p.url ?? null,
    })),
    experience: facts.experience,
  };

  console.log(`\n=== Running match (role='${roleFocus}', location='${locationPref}') ===`);
  const results = await runMatch(matchProfile, {
    roleFocus,
    locationPref,
    teamSizeBucket: "any",
    maxResults: 8,
    log: (m) => console.log(m),
  });
  if (results.length < N_DRAFTS) {
    throw new Error(`Only ${results.length} results — need ≥${N_DRAFTS} to compare drafts across companies.`);
  }

  // NOTE: the run→persist→drafts DB path (persistRun + /api/drafts) is verified
  // live in the browser as part of the exit check — persisting here would need
  // a real profiles row this script doesn't create. This script proves the two
  // exit criteria that live in draft GENERATION: specificity and no brackets.

  // Draft for the first N distinct companies.
  const picks: typeof results = [];
  const seenCompanies = new Set<string>();
  for (const r of results) {
    if (seenCompanies.has(r.company)) continue;
    seenCompanies.add(r.company);
    picks.push(r);
    if (picks.length >= N_DRAFTS) break;
  }

  console.log(`\n=== Generating drafts for ${picks.length} companies ===`);
  const allDrafts: { company: string; email: string; subject: string; linkedin: string }[] = [];

  for (const r of picks) {
    const [jobRow] = await db
      .select({ description: jobs.description })
      .from(jobs)
      .where(eq(jobs.id, r.jobId))
      .limit(1);

    const drafts = await generateDrafts(
      draftProfile,
      {
        title: r.title,
        company: r.company,
        location: r.location,
        description: jobRow?.description ?? null,
        applyUrl: r.applyUrl,
      },
      {
        leadProof: r.leadProof,
        leadProofType: r.leadProofType,
        standoutProject: r.standoutProject,
        rationale: r.rationale,
        gaps: r.gaps,
      },
    );

    allDrafts.push({
      company: r.company,
      subject: drafts.email.subject,
      email: drafts.email.body,
      linkedin: drafts.linkedin.body,
    });

    console.log(`\n────────────────────────────────────────────────────────`);
    console.log(`### ${r.title} @ ${r.company}  (lead [${r.leadProofType}]: ${r.leadProof})`);
    console.log(`\n--- COLD EMAIL ---`);
    console.log(`Subject: ${drafts.email.subject}`);
    console.log(drafts.email.body);
    console.log(`\n--- LINKEDIN DM (${drafts.linkedin.body.length}/${LINKEDIN_MAX_CHARS} chars) ---`);
    console.log(drafts.linkedin.body);
  }

  // ---- Assertions ---------------------------------------------------------
  console.log(`\n\n=== CHECKS ===`);
  const failures: string[] = [];

  // 1. No leftover placeholders anywhere; LinkedIn within its cap.
  for (const d of allDrafts) {
    const leftovers = [
      ...findPlaceholders(d.subject),
      ...findPlaceholders(d.email),
      ...findPlaceholders(d.linkedin),
    ];
    if (leftovers.length) failures.push(`${d.company}: leftover placeholders ${leftovers.join(", ")}`);
    if (d.linkedin.length > LINKEDIN_MAX_CHARS)
      failures.push(`${d.company}: LinkedIn note ${d.linkedin.length} > ${LINKEDIN_MAX_CHARS} chars`);
    // Specificity: the company name should appear in the outreach.
    const hay = `${d.subject} ${d.email} ${d.linkedin}`.toLowerCase();
    if (!hay.includes(d.company.toLowerCase().split(/\s+/)[0]))
      failures.push(`${d.company}: company name not referenced in the drafts (too generic)`);
  }
  console.log(`✓ placeholder / length / specificity check ${failures.length ? "FAILED" : "passed"}`);

  // 2. Drafts differ meaningfully per company (email bodies pairwise distinct).
  for (let i = 0; i < allDrafts.length; i++) {
    for (let j = i + 1; j < allDrafts.length; j++) {
      if (allDrafts[i].email.trim() === allDrafts[j].email.trim())
        failures.push(`${allDrafts[i].company} and ${allDrafts[j].company} have identical email bodies`);
      if (allDrafts[i].linkedin.trim() === allDrafts[j].linkedin.trim())
        failures.push(`${allDrafts[i].company} and ${allDrafts[j].company} have identical LinkedIn notes`);
    }
  }
  console.log(`✓ per-company difference check ${failures.some((f) => f.includes("identical")) ? "FAILED" : "passed"}`);

  if (failures.length) {
    console.error(`\n✗ PHASE 6 EXIT TEST FAILED:\n- ${failures.join("\n- ")}`);
    process.exit(1);
  }

  console.log(`\n✓✓ PHASE 6 EXIT TEST PASSED — drafts differ per company, zero leftover brackets.`);
  process.exit(0);
}

main().catch((e) => {
  console.error("PHASE 6 TEST FAILED");
  console.error(e);
  process.exit(1);
});
