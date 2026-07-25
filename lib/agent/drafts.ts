// Phase 6 — outreach drafts (REVISED-PLAN.md §8 Phase 6, §10).
//
// Per match, generate a cold email + a LinkedIn connection-note DM, each with a
// SPECIFIC hook pulled from the actual job/company text and the one-line "lead
// with this" resume angle. DRAFTS ONLY — nothing here ever sends.
//
// Voice/tone comes straight from the templates Siddhesh wrote by hand (the
// second sheet of Job-Search-Tracker.xlsx):
//   - Cold email: real hook → a project he actually built with the overlap made
//     explicit → "2025 ECE grad (PICT Pune), ships fast" → the role shape →
//     "worth a 15-min call? happy to build a POC against your product first".
//   - LinkedIn DM: same idea compressed into the 300-char connection-note limit.
//   - His stated differentiator is the "POC first" offer; the hook MUST be real
//     (a generic hook reads as spam).
//
// The exit-test criterion is enforced in code, not just asked for in the prompt:
// no leftover [BRACKET] placeholders, and the LinkedIn note within its char cap.
// If the model leaves one in, we do a corrective regeneration pass rather than
// shipping an unusable draft.

import { z } from "zod";
import { extractStructured } from "@/lib/llm";

export const LINKEDIN_MAX_CHARS = 300; // LinkedIn connection-note hard limit

export interface DraftProject {
  name: string;
  description: string;
  technologies: string[];
  url?: string | null; // a real live/repo link, or null — never a placeholder
}

export interface DraftProfile {
  name: string | null;
  githubUrl: string | null; // e.g. https://github.com/iamsiddhesh-dev
  headline: string | null; // one-line self-description, e.g. "2025 ECE grad (PICT Pune)…"
  projects: DraftProject[];
}

export interface DraftJob {
  title: string;
  company: string;
  location: string | null;
  description: string | null; // may be HTML
  applyUrl: string | null;
}

export interface DraftMatch {
  leadProject: string; // exact name of one of the profile's real projects
  rationale: string; // the specific product↔project overlap the matcher found
  gaps: string[];
}

export interface OutreachDrafts {
  email: { subject: string; body: string };
  linkedin: { body: string };
}

function stripHtml(s: string): string {
  return s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// A "[PLACEHOLDER]" is the failure mode the exit test forbids: an unfilled
// template slot. Real prose almost never contains bracketed spans, so flagging
// any [...] of a placeholder-ish length is safe and catches leftovers reliably.
const PLACEHOLDER_RX = /\[[^\]\n]{1,80}\]/g;

export function findPlaceholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER_RX)].map((m) => m[0]);
}

function draftIssues(d: OutreachDrafts): string[] {
  const issues: string[] = [];
  const leftovers = [
    ...findPlaceholders(d.email.subject),
    ...findPlaceholders(d.email.body),
    ...findPlaceholders(d.linkedin.body),
  ];
  if (leftovers.length) {
    issues.push(`Unfilled template placeholders were left in: ${[...new Set(leftovers)].join(", ")}. Replace every one with a real, specific detail, or remove that clause entirely if there is no real value for it.`);
  }
  if (d.linkedin.body.length > LINKEDIN_MAX_CHARS) {
    issues.push(`The LinkedIn note is ${d.linkedin.body.length} characters; it MUST be ${LINKEDIN_MAX_CHARS} or fewer. Tighten it.`);
  }
  return issues;
}

const draftSchema = z.object({
  email: z.object({
    subject: z
      .string()
      .describe("Cold email subject. Pattern: \"Built <project> — relevant to <company>'s <product area>\". Real project + real product area, no brackets."),
    body: z
      .string()
      .describe("The full cold email body, greeting to sign-off, newlines between paragraphs. Signed '- Siddhesh'. No placeholders."),
  }),
  linkedin: z.object({
    body: z
      .string()
      .describe(`A single LinkedIn connection-note message, ${LINKEDIN_MAX_CHARS} characters or fewer, no subject line, no placeholders.`),
  }),
});

function projectsBlock(projects: DraftProject[]): string {
  if (!projects.length) return "  (no projects on file)";
  return projects
    .map((p) => {
      const tech = p.technologies.length ? ` (tech: ${p.technologies.join(", ")})` : "";
      const link = p.url ? ` — live/repo link: ${p.url}` : " — no shareable link available";
      return `  - ${p.name}: ${p.description}${tech}${link}`;
    })
    .join("\n");
}

function buildPrompt(
  profile: DraftProfile,
  job: DraftJob,
  match: DraftMatch,
  corrections: string[],
): string {
  const desc = job.description ? stripHtml(job.description).slice(0, 2500) : "(no description text available)";
  const correctionBlock = corrections.length
    ? `\n\nFIX THESE PROBLEMS FROM YOUR PREVIOUS ATTEMPT:\n- ${corrections.join("\n- ")}\n`
    : "";

  return `You are ${profile.name ?? "a candidate"}'s outreach assistant. Write a cold email and a LinkedIn connection-note DM for ONE specific job opening, in ${profile.name ?? "the candidate"}'s own voice. These are DRAFTS the candidate will review and send himself — you never send anything.

CANDIDATE
Name: ${profile.name ?? "unknown"} (address the recipient by their first name is not possible — you do not know it; open the email with "Hi there," and the DM with "Hi —").
Self-description: ${profile.headline ?? "2025 ECE grad (PICT Pune) moving full-time into full-stack + AI engineering; ships fast."}
GitHub: ${profile.githubUrl ?? "(none provided)"}
Real projects (proof of work — you may ONLY reference these, never invent one):
${projectsBlock(profile.projects)}

THE OPENING
Role: ${job.title}
Company: ${job.company}
Location: ${job.location ?? "n/a"}
What they're building / role details:
"""
${desc}
"""

WHY IT'S A FIT (found by the matcher — use this as the spine of the hook)
Lead with this project: ${match.leadProject}
The specific overlap: ${match.rationale}
${match.gaps.length ? `Known gaps (do NOT hide these, but do NOT dwell on them): ${match.gaps.join("; ")}` : ""}

VOICE & STRUCTURE (from the candidate's own hand-written template — match it)
Cold email:
- Subject: "Built ${match.leadProject} — relevant to ${job.company}'s <their product area>" (fill in their real product area).
- Open "Hi there,".
- Line 1: a REAL, specific hook — what ${job.company} is actually building, drawn only from the role details above. One sentence showing you understand what they do and for whom. Do NOT invent funding rounds, launches, or news you cannot see in the text above — a fabricated hook is worse than none.
- Line 2: "I recently built ${match.leadProject} — <one line making the overlap with what they do explicit>." If (and only if) that project has a real link above, add "Live/code here: <the actual URL>." If it has no link, do not mention a link at all. Also point to the GitHub URL above if one exists.
- Line 3: the "2025 ECE grad (PICT Pune), moving into full-stack + AI, ships fast" angle, and the role shape you're after (founding / forward-deployed / full-stack engineer, or intern — whichever fits this team).
- Line 4: "Worth a 15-minute call? Happy to build a small POC against your product first if that's more useful." (This POC-first offer is the differentiator — keep it.)
- Sign off "- Siddhesh".

LinkedIn DM:
- One message, ${LINKEDIN_MAX_CHARS} characters or fewer (it's sent as a connection-request note).
- Open "Hi —". Name the project + the stack/domain overlap with ${job.company}, offer to prove it with a POC, mention 2025 grad, end with "Open to a quick chat?".

HARD RULES
- Output NO square-bracket placeholders. Every detail must be real and specific to ${job.company} and to ${profile.name ?? "the candidate"}'s actual projects. If you don't have a real value for something, rewrite the sentence so it isn't needed — never leave a "[...]" slot.
- The email and DM must be specific enough that they could not be sent to any other company unchanged.
- Never claim experience, metrics, or a link that isn't in the candidate data above.${correctionBlock}`;
}

export async function generateDrafts(
  profile: DraftProfile,
  job: DraftJob,
  match: DraftMatch,
): Promise<OutreachDrafts> {
  let corrections: string[] = [];
  let last: OutreachDrafts | null = null;

  // One initial attempt + up to 2 corrective passes. The model is explicitly
  // told what it left wrong, which reliably clears placeholders / length in one
  // retry; the loop is a safety net, not the expected path.
  for (let attempt = 0; attempt < 3; attempt++) {
    const drafts = await extractStructured({
      prompt: buildPrompt(profile, job, match, corrections),
      schema: draftSchema,
    });
    last = drafts;
    const issues = draftIssues(drafts);
    if (issues.length === 0) return drafts;
    corrections = issues;
  }

  // Exhausted retries — surface it rather than shipping a broken draft. The
  // exit test asserts this never happens against the real corpus.
  throw new Error(
    `Draft generation left unresolved issues after retries: ${draftIssues(last!).join(" | ")}`,
  );
}
