// Fuses resume facts + GitHub + LinkedIn text + portfolio URL into the one
// profile shape stored in `profiles` (db/schema.ts), plus a single embedding
// and a human-readable playback summary the chat shows back to the user so
// they can correct it before matching runs on a wrong understanding
// (REVISED-PLAN.md §7 step 3).

import { embedTexts } from "@/lib/llm";
import type { ResumeFacts } from "./resume";
import type { GithubProfile } from "./github";

export interface MergedProject {
  name: string;
  description: string;
  technologies: string[];
  source: "resume" | "github";
  url?: string;
}

export interface MergedProfile {
  name: string | null;
  skills: string[];
  projects: MergedProject[];
  seniority: string | null;
  embedding: number[];
  playback: string;
}

export async function mergeProfile(input: {
  resumeFacts?: ResumeFacts | null;
  github?: GithubProfile | null;
  linkedinText?: string | null;
  portfolioUrl?: string | null;
}): Promise<MergedProfile> {
  const { resumeFacts, github, linkedinText, portfolioUrl } = input;

  const skills = new Set<string>();
  for (const s of resumeFacts?.skills ?? []) skills.add(s);
  for (const r of github?.topRepos ?? []) if (r.language) skills.add(r.language);

  const projects: MergedProject[] = [
    ...(resumeFacts?.projects ?? []).map((p) => ({
      name: p.name,
      description: p.description,
      technologies: p.technologies,
      source: "resume" as const,
    })),
    ...(github?.topRepos ?? []).map((r) => ({
      name: r.name,
      description: r.description ?? "",
      technologies: r.language ? [r.language, ...r.topics] : r.topics,
      source: "github" as const,
      url: r.url,
    })),
  ];

  const name = resumeFacts?.name ?? github?.name ?? null;
  const seniority = resumeFacts?.seniority ?? null;

  const summaryParts: string[] = [];
  if (name) summaryParts.push(`Name: ${name}`);
  if (skills.size) summaryParts.push(`Skills: ${[...skills].join(", ")}`);
  if (projects.length) {
    summaryParts.push(
      "Projects:\n" +
        projects.map((p) => `- ${p.name}: ${p.description} (${p.technologies.join(", ")})`).join("\n"),
    );
  }
  for (const e of resumeFacts?.experience ?? []) {
    summaryParts.push(`Experience: ${e.title} at ${e.company}${e.duration ? ` (${e.duration})` : ""} — ${e.summary}`);
  }
  if (linkedinText) summaryParts.push(`LinkedIn export text:\n${linkedinText}`);
  if (portfolioUrl) summaryParts.push(`Portfolio: ${portfolioUrl}`);

  const embeddingSource = summaryParts.join("\n\n") || "empty profile";
  // The profile is matched AGAINST the job corpus, so embed it as a "query"
  // (Voyage's asymmetric-retrieval guidance); jobs are embedded as "document".
  const [embedding] = await embedTexts([embeddingSource], "query");

  const playback = buildPlayback({ name, skills: [...skills], projects, resumeFacts, github });

  return { name, skills: [...skills], projects, seniority, embedding, playback };
}

function buildPlayback(params: {
  name: string | null;
  skills: string[];
  projects: MergedProject[];
  resumeFacts?: ResumeFacts | null;
  github?: GithubProfile | null;
}): string {
  const { name, skills, projects, resumeFacts, github } = params;
  const lines: string[] = [];

  if (name) lines.push(`I see you're ${name}.`);
  if (projects.length) {
    lines.push(
      `I found ${projects.length} project${projects.length === 1 ? "" : "s"}, strongest looks like ${projects[0].name}.`,
    );
  }
  if (skills.length) lines.push(`Skills I picked up: ${skills.slice(0, 10).join(", ")}${skills.length > 10 ? ", …" : ""}.`);
  if (resumeFacts?.experience?.length) {
    const nonEngineering = resumeFacts.experience.filter((e) =>
      /video|design|editing|freelance/i.test(`${e.title} ${e.summary}`),
    );
    if (nonEngineering.length) {
      lines.push(
        `I also see freelance ${nonEngineering.map((e) => e.title).join(", ")} experience — I'll frame that as proof of client delivery, not a gap.`,
      );
    }
  }
  if (github) lines.push(`GitHub: ${github.publicRepos} public repos, top ones weighted by stars/recency.`);
  if (!name && !projects.length && !skills.length) {
    lines.push("I didn't find enough to build a profile from — could you share a resume or GitHub link?");
  }
  return lines.join(" ");
}
