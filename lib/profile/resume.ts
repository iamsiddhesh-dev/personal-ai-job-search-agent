// Resume parsing is storage-agnostic: it takes bytes, never a path. Where the
// bytes came from (upload, test fixture) is the caller's problem.

import { getDocumentProxy, extractText } from "unpdf";
import mammoth from "mammoth";
import { z } from "zod";
import { extractStructured } from "@/lib/llm";

export type ResumeFileKind = "pdf" | "docx" | "txt";

export function detectResumeKind(mimeType: string, filename: string): ResumeFileKind | null {
  const name = filename.toLowerCase();
  if (mimeType === "application/pdf" || name.endsWith(".pdf")) return "pdf";
  if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    name.endsWith(".docx")
  )
    return "docx";
  if (mimeType === "text/plain" || name.endsWith(".txt")) return "txt";
  return null;
}

export const resumeFactsSchema = z.object({
  name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  location: z.string().nullable(),
  seniority: z
    .string()
    .nullable()
    .describe("e.g. 'entry-level', 'junior', 'mid'; null if not inferable"),
  // Drives the match engine's eligibility gate (lib/agent/match.ts): a graduated
  // candidate should never be shown a role that requires active enrollment
  // ("must be currently pursuing a degree"), and vice versa. True only if the
  // resume states an in-progress degree (expected/future graduation date,
  // "currently pursuing", current year in program) — a past or unstated
  // graduation year means false.
  isCurrentStudent: z
    .boolean()
    .describe(
      "true only if the resume states the candidate is CURRENTLY enrolled in a degree program (expected/future graduation date, 'currently pursuing', etc). false if already graduated or education history has no clear in-progress program.",
    ),
  yearsOfExperience: z
    .number()
    .describe(
      "Years of RELEVANT professional/technical (software/engineering) experience, as a number. A student or new grad with only internships/projects is 0. Count full-time/professional roles only; do NOT count unrelated freelance (e.g. video editing) toward this number, and do NOT count academic projects. If unclear, use 0.",
    ),
  skills: z.array(z.string()),
  projects: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      technologies: z.array(z.string()),
    }),
  ),
  experience: z.array(
    z.object({
      company: z.string(),
      title: z.string(),
      duration: z.string().nullable(),
      summary: z.string(),
    }),
  ),
  education: z.array(
    z.object({
      institution: z.string(),
      degree: z.string(),
      graduationYear: z.string().nullable(),
    }),
  ),
});
export type ResumeFacts = z.infer<typeof resumeFactsSchema>;

export async function extractResumeText(bytes: Uint8Array, kind: ResumeFileKind): Promise<string> {
  let text: string;
  if (kind === "pdf") {
    const pdf = await getDocumentProxy(bytes);
    ({ text } = await extractText(pdf, { mergePages: true }));
  } else if (kind === "docx") {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    text = result.value;
  } else {
    text = Buffer.from(bytes).toString("utf-8");
  }
  if (!text.trim()) {
    throw new Error(`${kind.toUpperCase()} produced no extractable text (empty file, or a scanned/image-only PDF)`);
  }
  return text;
}

// The model has no built-in notion of "today" — without this, it cannot tell
// whether a stated graduation year/date is in the past (already graduated) or
// the future (still enrolled), which is exactly what isCurrentStudent depends
// on. Missing this produced a real bug: a candidate who graduated over a year
// ago was flagged as a current student because nothing told the model what
// "now" was to compare against.
function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function buildExtractionPrompt(text: string): string {
  return `You are extracting structured facts from a resume's raw text. Today's date is ${todayISO()}. Rules:
- Only report what is explicitly stated in the text below. Never infer, guess, or embellish.
- If a field is genuinely absent or ambiguous, use null (for scalar fields) or an empty array — do not invent a plausible-sounding value.
- For "seniority", base it only on years of experience or titles explicitly stated; if you cannot tell, use null.
- For "yearsOfExperience", give a NUMBER of years of relevant professional software/engineering work only. A new grad or student whose only software work is projects/internships is 0. Unrelated freelance (video editing, design) does NOT count toward this number.
- Freelance or non-engineering work (e.g. video editing, graphic design) still counts as real experience ENTRIES — include it in the experience array, do not drop it or relabel it as something it isn't. (It just doesn't inflate yearsOfExperience.)
- For "isCurrentStudent": compare the education entries' graduation date(s) against today's date (${todayISO()}) above. A graduation date already in the past means the candidate has GRADUATED — isCurrentStudent is false, even if a degree is the most recent education entry. Only a graduation date in the future, or explicit language like "currently pursuing", makes it true.

Resume text:
"""
${text}
"""`;
}

// A given resume's text never changes, so a re-upload of the same file (or a
// re-parse triggered by some other flow) is the exact same question asked
// twice — cache it near-indefinitely rather than re-spending a free-tier call
// on an answer that can't have changed.
const RESUME_CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

export async function extractResumeFacts(text: string): Promise<ResumeFacts> {
  return extractStructured({
    task: "resumeExtraction",
    prompt: buildExtractionPrompt(text),
    schema: resumeFactsSchema,
    cacheTtlMs: RESUME_CACHE_TTL_MS,
  });
}

// Second pass over already-extracted facts, checked against the original text.
// Catches the failure modes seen in production: (1) a real job/internship
// misfiled as a "project" (or vice versa), which silently starves the matcher's
// experience signal — see lib/agent/match.ts's leadProof logic, which prioritizes
// experience over projects and needs `experience` to actually be populated;
// (2) a skill/claim in the output that isn't actually backed by the resume
// text; and (3) isCurrentStudent set without correctly weighing the
// graduation date against today — the exact bug this field originally shipped
// with (a candidate who graduated over a year ago got flagged as a current
// student). Runs on a separate, cheap/fast model (task "hardening") since
// it's a bounded proofreading job, not open-ended extraction.
function buildHardeningPrompt(text: string, facts: ResumeFacts): string {
  return `You are proofreading structured facts that were extracted from a resume, checking them against the original text. Today's date is ${todayISO()}. Fix ONLY these three problems, and leave everything else exactly as-is:

1. MISCLASSIFICATION: an entry in "experience" that is actually a personal/academic project (no employer, unpaid, course work) should move to "projects" — and vice versa: a real job or internship (has an employer/company, even unpaid, even short) that was filed under "projects" should move to "experience". Recompute "yearsOfExperience" if this changes what counts as professional experience, following the same rule as before: relevant professional/technical experience only, freelance non-engineering work excluded, projects/internships-only history is 0.
2. HALLUCINATION: any skill, claim, or detail in the JSON that is NOT actually present in the resume text below must be removed.
3. isCurrentStudent CORRECTNESS: compare each education entry's graduation date against today's date (${todayISO()}) above. If the latest graduation date is in the past, isCurrentStudent MUST be false — a past graduation date always means already graduated, regardless of whether the degree is the most recent education entry. Only flip it to true if a graduation date is in the future or the text explicitly says the candidate is currently enrolled.

If nothing is wrong, return the facts unchanged.

Resume text:
"""
${text}
"""

Extracted facts (JSON) to check:
${JSON.stringify(facts, null, 2)}`;
}

// Non-fatal by design: this is a quality improvement on top of an already-valid
// extraction, and it sends the largest prompt we build (full resume + full
// prior JSON). If it fails for any reason, the un-hardened facts are still
// perfectly usable — returning those beats failing the whole upload.
export async function hardenResumeFacts(text: string, facts: ResumeFacts): Promise<ResumeFacts> {
  try {
    return await extractStructured({
      task: "hardening",
      prompt: buildHardeningPrompt(text, facts),
      schema: resumeFactsSchema,
      // Deterministic in its inputs (same resume text + same prior extraction
      // -> same check), so it caches on the same terms as extraction itself.
      cacheTtlMs: RESUME_CACHE_TTL_MS,
    });
  } catch {
    return facts;
  }
}

export async function parseResume(
  bytes: Uint8Array,
  kind: ResumeFileKind,
): Promise<{ text: string; facts: ResumeFacts }> {
  const text = await extractResumeText(bytes, kind);
  const rawFacts = await extractResumeFacts(text);
  const facts = await hardenResumeFacts(text, rawFacts);
  return { text, facts };
}
