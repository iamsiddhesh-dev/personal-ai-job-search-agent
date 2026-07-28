import { getOrCreateUser } from "@/lib/user";
import { uploadResume } from "@/lib/storage";
import { parseResume, detectResumeKind } from "@/lib/profile/resume";
import { fetchGithubProfile, parseGithubUsername } from "@/lib/profile/github";
import { parseLinkedinInput } from "@/lib/profile/linkedin";
import { saveProfile } from "@/lib/profile/save";

const MAX_RESUME_BYTES = 5 * 1024 * 1024;

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

  const userId = await getOrCreateUser();
  const notes: string[] = [];

  let resumePath: string | null = null;
  let resumeFilename: string | null = null;
  let resumeText: string | null = null;
  let resumeFacts = null as Awaited<ReturnType<typeof parseResume>>["facts"] | null;

  if (hasResume) {
    const file = resumeFile as File;
    const kind = detectResumeKind(file.type, file.name);
    if (!kind) {
      return Response.json(
        { error: `Unsupported resume file type: ${file.type || file.name}. Use PDF, DOCX, or TXT.` },
        { status: 400 },
      );
    }
    if (file.size > MAX_RESUME_BYTES) {
      return Response.json({ error: "Resume exceeds 5 MB limit." }, { status: 400 });
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const extension = file.name.split(".").pop() || kind;
    resumePath = await uploadResume(userId, Buffer.from(bytes), extension);
    resumeFilename = file.name;
    try {
      const parsed = await parseResume(bytes, kind);
      resumeText = parsed.text;
      resumeFacts = parsed.facts;
    } catch (err) {
      notes.push(`Couldn't parse the resume: ${(err as Error).message}`);
    }
  }

  let github = null as Awaited<ReturnType<typeof fetchGithubProfile>> | null;
  if (hasGithub) {
    try {
      github = await fetchGithubProfile(parseGithubUsername(githubUsername!));
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

  // Only pass what this request actually carried — saveProfile merges against
  // the stored row, so omitting a field keeps it rather than clearing it.
  const { profileId, playback, canSearch } = await saveProfile(userId, {
    name,
    ...(hasResume ? { resumePath, resumeFilename, resumeText, resumeFacts } : {}),
    ...(hasGithub ? { github } : {}),
    ...(hasLinkedin ? { linkedinText } : {}),
    ...(portfolioUrl ? { portfolioUrl } : {}),
  });

  return Response.json({ profileId, playback, notes, canSearch });
}

function asString(value: FormDataEntryValue | null): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
