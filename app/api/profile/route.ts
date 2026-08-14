import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { profiles } from "@/db/schema";
import { getOrCreateUser } from "@/lib/user";
import { removeFiles, uploadResume } from "@/lib/storage";
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

  // Read BEFORE saveProfile, not after. saveProfile overwrites resumePath with
  // whatever this request carries, and the old value is the only pointer to the
  // old object — there is no other column and no index holding it. Read it
  // afterwards and the previous file is unreachable from the database
  // permanently, which is precisely how every resume uploaded before today ended
  // up stranded in the bucket.
  const [before] = await db
    .select({ resumePath: profiles.resumePath })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);
  const previousResumePath = before?.resumePath ?? null;

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
  //
  // `name` is spread on the same rule as the rest, which it was not before.
  // Passing it unconditionally meant passing null whenever the form had no name
  // field, and null is an EXPLICIT CLEAR in saveProfile, not "nothing to say".
  // The stored name then fell through to whatever the new resume parsed out of
  // itself — so a name the user had typed into the chat was wiped by any upload
  // that didn't happen to carry one. The attach button sends exactly that: a
  // FormData holding only the file.
  const { profileId, playback, canSearch } = await saveProfile(userId, {
    ...(name ? { name } : {}),
    ...(hasResume ? { resumePath, resumeFilename, resumeText, resumeFacts } : {}),
    ...(hasGithub ? { github } : {}),
    ...(hasLinkedin ? { linkedinText } : {}),
    ...(portfolioUrl ? { portfolioUrl } : {}),
  });

  // Only once the new path is safely stored. Doing it before the save would
  // delete the file the profile still points at if the save then failed.
  //
  // The paths come from randomUUID() so they never collide, but the comparison
  // is here anyway: this must never be reachable by a code path that could hand
  // it the path it just saved.
  const replacedResume = !!resumePath && !!previousResumePath && previousResumePath !== resumePath;
  if (previousResumePath && replacedResume) {
    const removed = await removeFiles([previousResumePath]);
    console.log(`[profile] replaced resume for ${userId}; removed ${removed} previous object(s).`);
  }

  // Tells the client this was a REPLACEMENT rather than a first upload, so the
  // agent can offer a clean start instead of assuming one. See
  // ConversationPanel's handleAttach.
  return Response.json({ profileId, playback, notes, canSearch, replacedResume });
}

function asString(value: FormDataEntryValue | null): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
