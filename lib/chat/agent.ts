// The conversational agent (replaces the old fixed 6-step state machine in
// flow.ts). The conversation is now LLM-driven and open-ended: the user can say
// anything at any point, in any order, and keep talking after results land —
// there is no terminal step.
//
// The model drives, but every side effect goes through a TOOL, so the real work
// (matching, drafting, the tracker) stays in the same audited code paths the
// old flow used. The model chooses WHEN to act and how to talk about it; it
// never invents results.
//
// Tool calling constrains the model choice: Cerebras' endpoint rejects tool
// definitions outright (400), and Gemini's 20-requests-per-day free tier is far
// too small for a chat loop that fires on every message. Groq is the only
// provider measured to handle tools reliably (2/2), so the chat chain is Groq
// first with Gemini kept as an emergency backstop.

import { generateText, stepCountIs, tool, type ModelMessage } from "ai";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { profiles } from "@/db/schema";
import { chatModelChain } from "@/lib/llm";
import { getOrCreateSingleUser } from "@/lib/user";
import { getExcludedJobIds, listDueFollowups, markApplied } from "@/lib/applications";
import { buildMatchProfileFromRow } from "@/lib/agent/build-profile";
import { runMatch, type LocationPref, type TeamSizeBucket, type RankedMatch } from "@/lib/agent/match";
import { persistRun } from "@/lib/agent/persist";

export interface AgentEvent {
  type: "status" | "jobs" | "text" | "error";
  message?: string;
  jobs?: RankedMatch[];
}

export type Emit = (event: AgentEvent) => void;

// Voice and behaviour. Deliberately specific: a generic "helpful assistant"
// prompt produces the stilted, form-like replies this rewrite exists to remove.
const SYSTEM_PROMPT = `you are "backdoor" — a job-hunting agent for ONE person, helping them land roles at startups. you talk like a sharp friend who happens to be a great recruiter, not like a form or a support bot.

VOICE
- lowercase, casual, warm, direct. short messages. contractions.
- react to what they actually said before moving on ("nashik, nice — plenty of pune/remote options"). never ignore an answer.
- one idea per message. ask ONE question at a time, not a list of five.
- no corporate filler: never say "certainly", "I'd be happy to assist", "as an AI".
- be opinionated. if something is a weak fit, say so plainly.

HOW YOU WORK
- the conversation NEVER ends. after results, drafts, anything — stay in it, suggest the next useful thing, and keep taking requests.
- you already have tools for the real work. use them instead of guessing:
  - getProfile: check what you know about them. call this EARLY, before asking for things you already have.
  - searchJobs: find matching roles. needs a profile to exist first.
  - markApplied: when they say they applied to something.
  - getFollowups: when they ask what needs chasing.
- NEVER invent a job, company, score, or link. only ever describe what a tool returned.
- job results render as cards in the ui automatically. so don't re-list every job in text — say what stands out and why, in a sentence or two, then invite the next step.

GETTING STARTED
- if there's no profile yet, you need a resume / github / linkedin / portfolio. tell them to use the attach button to upload a resume, or just paste a github or linkedin url into the chat.
- before searching, you want a rough sense of: what kind of role, and location/remote preference. ask conversationally, one at a time — don't interrogate. if they've already implied an answer, use it and don't re-ask.
- don't block on perfect information. if they say "just find me something", search with sensible defaults and say what you assumed.`;

interface ToolContext {
  userId: string;
  emit: Emit;
  // Filled in when searchJobs runs, so the route can attach cards to the reply.
  collectedJobs: RankedMatch[];
}

async function loadProfileRow(userId: string) {
  const [row] = await db.select().from(profiles).where(eq(profiles.userId, userId)).limit(1);
  return row ?? null;
}

function buildTools(ctx: ToolContext) {
  return {
    getProfile: tool({
      description:
        "Look up what is already known about this candidate (name, skills, projects, experience, whether a resume/github is on file). Call this before asking them for anything.",
      inputSchema: z.object({}),
      execute: async () => {
        const row = await loadProfileRow(ctx.userId);
        if (!row) return { hasProfile: false as const };
        const facts = (row.resumeFacts ?? null) as {
          yearsOfExperience?: number;
          location?: string | null;
          experience?: { title: string; company: string }[];
        } | null;
        return {
          hasProfile: true as const,
          name: row.name,
          seniority: row.seniority,
          location: facts?.location ?? null,
          yearsOfExperience: facts?.yearsOfExperience ?? 0,
          skills: (row.skills ?? []).slice(0, 25),
          projects: ((row.projects ?? []) as { name: string }[]).map((p) => p.name),
          experience: (facts?.experience ?? []).map((e) => `${e.title} at ${e.company}`),
          hasResume: !!row.resumePath,
          hasGithub: !!row.github,
          // Without an embedding the matcher cannot run (see build-profile.ts).
          canSearch: !!row.embedding,
        };
      },
    }),

    searchJobs: tool({
      description:
        "Search the live job database for roles matching this candidate. Returns ranked matches, which the UI renders as cards. Only call when a profile exists.",
      inputSchema: z.object({
        roleFocus: z
          .string()
          .describe("the kind of role, e.g. 'full-stack', 'ai', 'backend', 'frontend', 'fde', or 'any'"),
        locationPref: z
          .enum(["india", "remote", "anywhere"])
          .describe("'india' includes India-based and remote roles; 'anywhere' drops the location filter"),
        teamSizeBucket: z
          .enum(["lt10", "10-50", "50-200", "any"])
          .describe("company size preference; use 'any' unless they said otherwise"),
      }),
      execute: async ({ roleFocus, locationPref, teamSizeBucket }) => {
        const row = await loadProfileRow(ctx.userId);
        if (!row) {
          return { ok: false as const, reason: "No profile yet — they need to share a resume, GitHub or LinkedIn first." };
        }
        let matchProfile;
        try {
          matchProfile = buildMatchProfileFromRow(row);
        } catch (err) {
          return { ok: false as const, reason: (err as Error).message };
        }

        ctx.emit({ type: "status", message: "searching the job database…" });
        const excludeJobIds = await getExcludedJobIds(ctx.userId);
        const results = await runMatch(matchProfile, {
          roleFocus,
          locationPref: locationPref as LocationPref,
          teamSizeBucket: teamSizeBucket as TeamSizeBucket,
          excludeJobIds,
          log: (m) => ctx.emit({ type: "status", message: m }),
        });

        // Persist so each card carries a matches.id that outreach drafts can
        // reference. A persistence failure must not lose good results.
        let jobs = results;
        try {
          jobs = await persistRun({
            userId: ctx.userId,
            profileId: row.id,
            roleFocus,
            filters: { locationPref, teamSizeBucket },
            results,
          });
        } catch {
          // Non-fatal: cards still render, the draft button just won't work.
        }

        ctx.collectedJobs = jobs;
        ctx.emit({ type: "jobs", jobs });

        // Hand the model a compact summary, NOT the full objects — it only
        // needs enough to comment intelligently, and the cards carry the rest.
        return {
          ok: true as const,
          count: jobs.length,
          matches: jobs.slice(0, 10).map((j) => ({
            title: j.title,
            company: j.company,
            score: j.score,
            location: j.location,
            isRemote: j.isRemote,
            leadProof: j.leadProof,
            leadProofType: j.leadProofType,
            gaps: j.gaps,
          })),
        };
      },
    }),

    markApplied: tool({
      description: "Record that the candidate applied to a role, so it stops showing up in future searches.",
      inputSchema: z.object({
        company: z.string(),
        roleTitle: z.string(),
        jobId: z.string().nullable().describe("the job's id if it came from a search result card, else null"),
      }),
      execute: async ({ company, roleTitle, jobId }) => {
        const id = await markApplied({
          userId: ctx.userId,
          jobId: jobId ?? null,
          companyName: company,
          roleTitle,
        });
        return { ok: true as const, applicationId: id };
      },
    }),

    getFollowups: tool({
      description: "List applications that are due a follow-up nudge.",
      inputSchema: z.object({}),
      execute: async () => {
        const due = await listDueFollowups(ctx.userId);
        return {
          count: due.length,
          due: due.map((a) => ({ company: a.company, role: a.title, status: a.status })),
        };
      },
    }),
  };
}

export interface ChatTurnResult {
  text: string;
  jobs: RankedMatch[];
}

// Run one turn of the conversation. `history` is the RECENT transcript (the
// caller — /api/chat — compacts anything older into `summary`, see
// lib/chat/summarize.ts); the server stays stateless and the client owns the
// full thread.
export async function runChatTurn(
  history: ModelMessage[],
  emit: Emit,
  summary?: string,
): Promise<ChatTurnResult> {
  const userId = await getOrCreateSingleUser();
  const ctx: ToolContext = { userId, emit, collectedJobs: [] };
  const tools = buildTools(ctx);

  const chain = chatModelChain();
  if (chain.length === 0) {
    throw new Error("No chat-capable API key configured. Set GROQ_API_KEYS (comma-separated) in .env.");
  }

  const system = summary
    ? `${SYSTEM_PROMPT}\n\nEARLIER IN THIS CONVERSATION (summarized — treat as established fact, don't re-ask):\n${summary}`
    : SYSTEM_PROMPT;

  let lastErr: unknown;
  for (const model of chain) {
    try {
      const result = await generateText({
        model,
        system,
        messages: history,
        tools,
        // Enough steps to look something up, act on it, then talk about it.
        stopWhen: stepCountIs(6),
      });
      return { text: result.text.trim(), jobs: ctx.collectedJobs };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
