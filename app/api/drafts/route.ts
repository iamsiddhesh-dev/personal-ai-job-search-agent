// Phase 6 — outreach drafts endpoint. POST { matchId, regenerate? } returns a
// cold email + LinkedIn DM for that match. Results are cached in the `drafts`
// table (one row per kind) and reused unless `regenerate` is set.
//
// DRAFTS ONLY — this route generates text for the user to review and send
// himself. It never sends anything (REVISED-PLAN §10).

import { db } from "@/lib/db";
import { drafts, matches, jobs, companies, runs, profiles } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  generateDrafts,
  type DraftProfile,
  type DraftProject,
  type OutreachDrafts,
} from "@/lib/agent/drafts";
import type { GithubProfile } from "@/lib/profile/github";
import type { ResumeFacts } from "@/lib/profile/resume";

interface DraftsRequest {
  matchId: string;
  regenerate?: boolean;
}

// The candidate's one-line positioning, built entirely from their own profile.
// Nothing here may describe a discipline the profile doesn't show: calling a
// data engineer a "full-stack + AI engineer" puts a false claim in an email
// they're about to send under their own name.
function buildHeadline(
  facts: ResumeFacts | null,
  seniority: string | null,
  skills: string[],
): string | null {
  const parts: string[] = [];

  const edu = facts?.education?.[0];
  if (edu) {
    const year = edu.graduationYear ? `${edu.graduationYear} ` : "";
    parts.push(`${year}grad — ${edu.degree}, ${edu.institution}`.trim());
  }

  // Top skills stand in for the discipline; without them, stay generic rather
  // than guess a specialism.
  const focus = skills.slice(0, 3).join(" / ");
  const level = seniority ?? "early-career";
  parts.push(focus ? `${level} engineer — ${focus}` : `${level} software engineer`);

  return parts.length ? parts.join("; ") : null;
}

export async function POST(req: Request) {
  const body = (await req.json()) as DraftsRequest;
  const { matchId, regenerate } = body;
  if (!matchId) {
    return Response.json({ error: "matchId is required." }, { status: 400 });
  }

  // Return the cached drafts unless a fresh generation was explicitly asked for.
  if (!regenerate) {
    const existing = await db.select().from(drafts).where(eq(drafts.matchId, matchId));
    if (existing.length > 0) {
      const email = existing.find((d) => d.kind === "email");
      const linkedin = existing.find((d) => d.kind === "linkedin");
      if (email && linkedin) {
        return Response.json({
          drafts: {
            email: { subject: email.subject ?? "", body: email.body ?? "" },
            linkedin: { body: linkedin.body ?? "" },
          },
          cached: true,
        });
      }
    }
  }

  // Load the match, its job + company, and the profile behind its run.
  const [row] = await db
    .select({
      leadProof: matches.leadProof,
      leadProofType: matches.leadProofType,
      standoutProject: matches.standoutProject,
      rationale: matches.rationale,
      gaps: matches.gaps,
      jobTitle: jobs.title,
      jobDescription: jobs.description,
      jobLocation: jobs.location,
      jobApplyUrl: jobs.applyUrl,
      companyName: companies.name,
      profileName: profiles.name,
      profileProjects: profiles.projects,
      profileGithub: profiles.github,
      profileResumeFacts: profiles.resumeFacts,
      profileSeniority: profiles.seniority,
      profileSkills: profiles.skills,
    })
    .from(matches)
    .innerJoin(jobs, eq(matches.jobId, jobs.id))
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .innerJoin(runs, eq(matches.runId, runs.id))
    .innerJoin(profiles, eq(runs.profileId, profiles.id))
    .where(eq(matches.id, matchId))
    .limit(1);

  if (!row) {
    return Response.json({ error: "Match not found." }, { status: 404 });
  }

  const github = (row.profileGithub ?? null) as GithubProfile | null;
  const facts = (row.profileResumeFacts ?? null) as ResumeFacts | null;
  const projects = ((row.profileProjects ?? []) as DraftProject[]).map((p) => ({
    name: p.name,
    description: p.description,
    technologies: p.technologies ?? [],
    url: p.url ?? null,
  }));
  const experience = (facts?.experience ?? []).map((e) => ({
    title: e.title,
    company: e.company,
    duration: e.duration,
    summary: e.summary,
  }));

  const profile: DraftProfile = {
    name: row.profileName ?? github?.name ?? null,
    githubUrl: github?.username ? `https://github.com/${github.username}` : null,
    headline: buildHeadline(facts, row.profileSeniority, row.profileSkills ?? []),
    projects,
    experience,
  };

  let generated: OutreachDrafts;
  try {
    generated = await generateDrafts(
      profile,
      {
        title: row.jobTitle,
        company: row.companyName,
        location: row.jobLocation,
        description: row.jobDescription,
        applyUrl: row.jobApplyUrl,
      },
      {
        leadProof: row.leadProof ?? (experience[0]?.title ?? projects[0]?.name ?? "my work"),
        leadProofType: (row.leadProofType as "experience" | "project" | null) ?? (experience.length ? "experience" : "project"),
        standoutProject: row.standoutProject ?? null,
        rationale: row.rationale ?? "",
        gaps: row.gaps ?? [],
      },
    );
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }

  // Replace any prior drafts for this match, then store the fresh pair.
  await db.delete(drafts).where(eq(drafts.matchId, matchId));
  await db.insert(drafts).values([
    { matchId, kind: "email", subject: generated.email.subject, body: generated.email.body },
    { matchId, kind: "linkedin", subject: null, body: generated.linkedin.body },
  ]);

  return Response.json({ drafts: generated, cached: false });
}
