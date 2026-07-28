// The one place a profile row is written.
//
// Two callers need this: the upload route (/api/profile) and the chat agent's
// saveProfile tool. They must not each own a copy — the write recomputes the
// embedding from the merged inputs, so a second implementation that forgot to
// would leave a profile that silently can't be searched.
//
// Every input is optional and MERGED with what's already stored, because the
// two callers arrive with different fragments: the route brings a parsed
// resume, the chat tool brings a name or a GitHub URL typed mid-conversation.
// A caller that doesn't know about a field must never blank it.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { profiles } from "@/db/schema";
import { mergeProfile } from "./merge";
import type { ResumeFacts } from "./resume";
import type { GithubProfile } from "./github";

export interface ProfileInput {
  name?: string | null;
  resumePath?: string | null;
  resumeFilename?: string | null;
  resumeText?: string | null;
  resumeFacts?: ResumeFacts | null;
  github?: GithubProfile | null;
  linkedinText?: string | null;
  portfolioUrl?: string | null;
}

export interface SaveProfileResult {
  profileId: string;
  playback: string;
  /** False when there's still no embedding — the matcher can't run without one. */
  canSearch: boolean;
}

export async function saveProfile(
  userId: string,
  input: ProfileInput,
): Promise<SaveProfileResult> {
  const [existing] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);

  // `undefined` means "caller had nothing to say about this field" and keeps
  // the stored value; `null` is an explicit clear. Distinguishing the two is
  // what makes incremental saves from chat safe.
  const pick = <T>(next: T | null | undefined, prev: T | null): T | null =>
    next === undefined ? prev : next;

  const resumeFacts = pick(
    input.resumeFacts,
    (existing?.resumeFacts ?? null) as ResumeFacts | null,
  );
  const github = pick(input.github, (existing?.github ?? null) as GithubProfile | null);
  const linkedinText = pick(input.linkedinText, existing?.linkedinText ?? null);
  const portfolioUrl = pick(input.portfolioUrl, existing?.portfolioUrl ?? null);

  // Re-derived from the full merged picture every time, so adding a GitHub
  // account later re-embeds against the resume too rather than in isolation.
  const merged = await mergeProfile({
    resumeFacts,
    github,
    linkedinText,
    portfolioUrl: portfolioUrl ?? undefined,
  });

  const values = {
    userId,
    name: pick(input.name, existing?.name ?? null) ?? merged.name,
    resumePath: pick(input.resumePath, existing?.resumePath ?? null),
    resumeFilename: pick(input.resumeFilename, existing?.resumeFilename ?? null),
    resumeUploadedAt: input.resumePath ? new Date() : (existing?.resumeUploadedAt ?? null),
    resumeText: pick(input.resumeText, existing?.resumeText ?? null),
    resumeFacts,
    github,
    linkedinText,
    portfolioUrl,
    skills: merged.skills,
    projects: merged.projects,
    seniority: merged.seniority,
    embedding: merged.embedding,
  };

  const profileId = existing
    ? (
        await db
          .update(profiles)
          .set(values)
          .where(eq(profiles.id, existing.id))
          .returning({ id: profiles.id })
      )[0].id
    : (await db.insert(profiles).values(values).returning({ id: profiles.id }))[0].id;

  return {
    profileId,
    playback: merged.playback,
    canSearch: !!merged.embedding,
  };
}
