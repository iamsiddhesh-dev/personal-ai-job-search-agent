import { db } from "@/lib/db";
import { profiles } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getOrCreateSingleUser } from "@/lib/user";
import { uploadResume } from "@/lib/storage";
import { parseResume } from "@/lib/profile/resume";
import { fetchGithubProfile } from "@/lib/profile/github";
import { parseLinkedinInput } from "@/lib/profile/linkedin";
import { mergeProfile } from "@/lib/profile/merge";

const MAX_RESUME_BYTES = 5 * 1024 * 1024;
const ALLOWED_RESUME_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

export async function POST(req: Request) {
  const form = await req.formData();

  const name = asString(form.get("name"));
  const resumeFile = form.get("resume");
  const githubUsername = asString(form.get("githubUsername"));
  const linkedinFile = form.get("linkedin");
  const linkedinUrl = asString(form.get("linkedinUrl"));
  const portfolioUrl = asString(form.get("portfolioUrl"));

  const hasResume = resumeFile instanceof File && resumeFile.size > 0;
  const hasGithub = !!githubUsername;
  const hasLinkedin = (linkedinFile instanceof File && linkedinFile.size > 0) || !!linkedinUrl;

  if (!hasResume && !hasGithub && !hasLinkedin) {
    return Response.json(
      { error: "Provide at least one of: resume, GitHub username, or LinkedIn." },
      { status: 400 },
    );
  }

  const userId = await getOrCreateSingleUser();
  const notes: string[] = [];

  let resumePath: string | null = null;
  let resumeFilename: string | null = null;
  let resumeText: string | null = null;
  let resumeFacts = null as Awaited<ReturnType<typeof parseResume>>["facts"] | null;

  if (hasResume) {
    const file = resumeFile as File;
    if (!ALLOWED_RESUME_TYPES.has(file.type)) {
      return Response.json({ error: `Unsupported resume file type: ${file.type}. Use PDF or DOCX.` }, { status: 400 });
    }
    if (file.size > MAX_RESUME_BYTES) {
      return Response.json({ error: "Resume exceeds 5 MB limit." }, { status: 400 });
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const extension = file.name.split(".").pop() || "pdf";
    resumePath = await uploadResume(userId, Buffer.from(bytes), extension);
    resumeFilename = file.name;
    try {
      const parsed = await parseResume(bytes);
      resumeText = parsed.text;
      resumeFacts = parsed.facts;
    } catch (err) {
      notes.push(`Couldn't parse the resume: ${(err as Error).message}`);
    }
  }

  let github = null as Awaited<ReturnType<typeof fetchGithubProfile>> | null;
  if (hasGithub) {
    try {
      github = await fetchGithubProfile(githubUsername!);
    } catch (err) {
      notes.push(`Couldn't fetch GitHub profile: ${(err as Error).message}`);
    }
  }

  let linkedinText: string | null = null;
  if (hasLinkedin) {
    const bytes =
      linkedinFile instanceof File && linkedinFile.size > 0
        ? new Uint8Array(await linkedinFile.arrayBuffer())
        : undefined;
    const result = await parseLinkedinInput({ bytes, url: linkedinUrl ?? undefined });
    linkedinText = result.text;
    if (result.note) notes.push(result.note);
  }

  const merged = await mergeProfile({ resumeFacts, github, linkedinText, portfolioUrl: portfolioUrl ?? undefined });

  const profileName = name ?? merged.name;
  const values = {
    userId,
    name: profileName,
    resumePath,
    resumeFilename,
    resumeUploadedAt: resumePath ? new Date() : null,
    resumeText,
    resumeFacts,
    github,
    linkedinText,
    portfolioUrl: portfolioUrl ?? null,
    skills: merged.skills,
    projects: merged.projects,
    seniority: merged.seniority,
    embedding: merged.embedding,
  };

  const [existing] = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.userId, userId)).limit(1);

  const profileId = existing
    ? (await db.update(profiles).set(values).where(eq(profiles.id, existing.id)).returning({ id: profiles.id }))[0].id
    : (await db.insert(profiles).values(values).returning({ id: profiles.id }))[0].id;

  return Response.json({
    profileId,
    playback: merged.playback,
    notes,
  });
}

function asString(value: FormDataEntryValue | null): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
