// Assembles the matcher's MatchProfile from a stored `profiles` row (built at
// /api/profile time by lib/profile/merge.ts). Mirrors scripts/test-phase3.ts's
// hand-assembly so the request path and the exit-test script build the same
// shape from the same source data.

import type { MatchProfile, MatchProject } from "./match";
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

  const summaryParts: string[] = [];
  for (const e of facts?.experience ?? []) {
    summaryParts.push(
      `Experience: ${e.title} at ${e.company}${e.duration ? ` (${e.duration})` : ""} — ${e.summary}`,
    );
  }
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
    location: facts?.location ?? null,
    skills: row.skills ?? [],
    projects: (row.projects as MatchProject[] | null) ?? [],
    embedding,
    summaryText: summaryParts.join("\n"),
  };
}
