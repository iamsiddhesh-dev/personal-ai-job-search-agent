// Assembles the matcher's MatchProfile from a stored `profiles` row (built at
// /api/profile time by lib/profile/merge.ts). Mirrors scripts/test-phase3.ts's
// hand-assembly so the request path and the exit-test script build the same
// shape from the same source data.

import type { MatchProfile, MatchProject, MatchExperience } from "./match";
import type { ResumeFacts } from "@/lib/profile/resume";

interface ProfileRow {
  name: string | null;
  seniority: string | null;
  resumeFacts: unknown;
  skills: string[] | null;
  projects: unknown;
  embedding: unknown;
}

function toVec(v: unknown): number[] | null {
  if (Array.isArray(v)) return v as number[];
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function buildMatchProfileFromRow(row: ProfileRow): MatchProfile {
  const facts = (row.resumeFacts ?? null) as ResumeFacts | null;

  // Experience gets its own structured field (below) so the matcher can give it
  // equal billing with projects instead of burying it in prose — see
  // lib/agent/match.ts's leadProof logic, which prioritizes real jobs/internships
  // over projects when picking what to lead with. summaryText now only carries
  // education + any prose the structured fields don't capture.
  const summaryParts: string[] = [];
  for (const ed of facts?.education ?? []) {
    summaryParts.push(
      `Education: ${ed.degree}, ${ed.institution}${ed.graduationYear ? ` (${ed.graduationYear})` : ""}`,
    );
  }

  const embedding = toVec(row.embedding);
  if (!embedding || embedding.length === 0) {
    throw new Error(
      "This profile has no embedding yet — share a resume, GitHub, or LinkedIn first so there's something to match against.",
    );
  }

  return {
    name: row.name,
    seniority: row.seniority,
    yearsExperience: facts?.yearsOfExperience ?? 0,
    isCurrentStudent: facts?.isCurrentStudent ?? false,
    location: facts?.location ?? null,
    skills: row.skills ?? [],
    projects: (row.projects as MatchProject[] | null) ?? [],
    experience: (facts?.experience ?? []).map(
      (e): MatchExperience => ({
        title: e.title,
        company: e.company,
        duration: e.duration,
        summary: e.summary,
      }),
    ),
    embedding,
    summaryText: summaryParts.join("\n"),
  };
}
