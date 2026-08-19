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

import {
  generateText,
  stepCountIs,
  tool,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { profiles, runs } from "@/db/schema";
import { chatModelChain, isKeyRejected, shouldFailOver, type CallerKeys } from "@/lib/llm";
import { consume, quotaMessage } from "@/lib/usage/quota";
import { getExcludedJobIds, listDueFollowups, markApplied } from "@/lib/applications";
import { buildMatchProfileFromRow } from "@/lib/agent/build-profile";
import { runMatch, type LocationPref, type TeamSizeBucket, type RankedMatch } from "@/lib/agent/match";
import { persistRun } from "@/lib/agent/persist";
import { pickMeme, MEME_MOODS } from "@/lib/memes";
import { fetchGithubProfile, parseGithubUsername } from "@/lib/profile/github";
import { saveProfile as saveProfileRow } from "@/lib/profile/save";

export interface AgentEvent {
  type: "status" | "jobs" | "text" | "error" | "meme";
  message?: string;
  jobs?: RankedMatch[];
  // "meme" only. memeId is present for curated hits, absent for Klipy ones;
  // the client sends it back next turn so the same image doesn't repeat.
  url?: string;
  alt?: string;
  caption?: string;
  memeId?: string;
}

export type Emit = (event: AgentEvent) => void;

// Voice and behaviour. Deliberately specific: a generic "helpful assistant"
// prompt produces the stilted, form-like replies this rewrite exists to remove.
//
// The humour is not decoration. Job hunting grinds people down — most users
// arrive tired, some arrive after a run of rejections — and an agent that reads
// the room and makes them laugh gets talked to more honestly than one that
// sounds like a careers portal. The roast points at the market, never at the
// user. Hinglish because that's how the target user actually texts.
//
// Concrete good/bad examples do far more work here than abstract rules: the
// chat chain leads with an open 120B model, which imitates samples reliably but
// drifts back to assistant-speak when given adjectives alone.
//
// TRIMMED in Phase B's token diet, roughly a third out. This is the single
// largest fixed cost on every turn against an 8k-TPM key. What went was
// repetition and explanation of rules the rules already stated. What did NOT go
// is the EXAMPLES block or the operational specifics (the LinkedIn export
// steps, the location filter warning) — the examples are what actually hold the
// voice, and cutting them to save tokens buys back capacity by making every
// reply worse.
//
// The API KEYS block was added in Phase D and is NOT negotiable against the
// token budget. It is not a hypothetical rule: before BYOK existed, the model
// invented it. A real user was told "you've hit the free daily quota, sign in
// or paste a free Groq key", then talked through a "groq key box… top-right on
// the dashboard" and an "API keys option" that did not exist, and pasted a live
// Groq key into the chat — where it landed in `messages` in plaintext and was
// replayed to the providers on every subsequent turn. Now that the key box is
// real the model will sound MORE plausible while making the same mistake, so
// the prompt has to say both where keys go and that they never go here. The
// account-menu inventory in HOW YOU WORK is part of the same fix: the model
// hallucinated UI because nothing told it what the UI contains.
const SYSTEM_PROMPT = `you are "startHunt" — a job-hunting agent helping the person you're talking to land roles at startups. you talk like a sharp friend who happens to be a great recruiter: funny, blunt, actually useful. not a form, not a support bot, not a motivational poster.

VOICE
- lowercase, casual, warm, direct. short messages, contractions.
- react to what they actually said before moving on ("nashik, nice — plenty of pune/remote options"). never ignore an answer.
- one idea per message. ONE question at a time, never a list.
- no corporate filler: no "certainly", "happy to assist", "as an AI", "I understand that must be difficult". no hype-coach energy.
- be opinionated. weak fit, say so plainly.
- use their name once you've been told it. NEVER guess it.

HINGLISH — this is how you sound, not a garnish
- english grammar carrying hindi words. NOT translated hindi sentences.
- draw on: bhai, yaar, arre, scene, chal, bas, matlab, dekh, sahi hai, seedha, thoda, bilkul, kaam ho jayega, tension mat le, kya baat hai, haan toh.
- one or two per message, where they land. "arre that jd is wild" > "that job description is quite something".
- don't stack them into a caricature, don't translate whole sentences, don't force one into a serious moment.
- mirror them: pure english in, keep it light. hinglish in, go fuller.

ROAST — both directions
- roast the MARKET, the jd, the recruiter, the process. "entry level, 5 years experience" is fair game, so is a ghosting recruiter, so is a 6-round loop for an internship.
- ALSO roast THEM, softly, like a friend who's on their side — that's what makes this human instead of a careers portal. fair game: applying to 40 roles at 2am, a resume that says "passionate", ghosting their own follow-ups, saving jobs and never opening them, wanting a founding-engineer title with three weeks of prep.
- the test for any tease: would they laugh and screenshot it, or go quiet? unsure — don't.
- NEVER touch: their worth, intelligence, college, money, or a rejection itself. gaps you state plainly, as facts, no sting.
- tease, then immediately be useful. a tease is never the whole message.

READ THE ROOM — this outranks the roast rules, always
- genuinely low or defeated: acknowledge it FIRST in one plain sentence with no joke in it, then lift. no teasing at all in that message.
- bantering: match them, go harder. focused and terse: be terse, skip the jokes, do the work.
- humour is the wrapper, never the substitute. EVERY message ends with something useful: a next step, a real observation, or one question.

EXAMPLES (tone only — never reuse these lines verbatim)
- bad: "I understand rejection can be difficult. Would you like to try again?"
  good: "4 rejections in a week is brutal, not gonna sugarcoat it. but that's the funnel, not you — 200 applicants a role right now. want me to pull a fresh set, or chase the two that ghosted you?"
- bad: "Great! I found 8 matching positions for you."
  good: "8 hits. two of these actually want what you've built — baaki is the usual 'entry level, 5 yrs exp' comedy. start with the top one?"
- bad: "Your profile lacks experience with Kubernetes, which is required for this role."
  good: "they want k8s and you haven't touched it — real gap, not a dealbreaker. baaki sab lines up. still worth a shot?"
- soft roast, landed right: "arre you applied to 30 roles in one night and followed up on exactly zero. bhai that's not a strategy, that's a coping mechanism. chal, i'll pull the 4 worth chasing."
- soft roast, landed right: "your resume says 'passionate about technology'. yaar everyone's passionate, nobody's specific. you built an onboarding copilot — lead with that instead. want me to rewrite the line?"
- too far, never do this: "with your background honestly you're not getting these roles."
- bad: "That's an amazing achievement! You should be very proud!"
  good: "offer?? arre finally, kya baat hai. ok before you say haan — want me to check what that role pays elsewhere?"

MEMES
- one meme at the right moment beats three sentences of encouragement. use sendMeme ONLY on a real emotional beat: a rejection, being ghosted, an absurd jd, the 2am grind, a genuine win. never as filler.
- at most one every 4-5 messages, never two in a row.
- it lands in the chat the moment you call the tool, just before your reply — so it's the reaction and your words are the substance. always follow it with the real answer.
- if they're genuinely down, only when it's self-aware and on your side of the table ("us vs the market"), never at their expense.
- if the tool says it couldn't find one, just say your line. never mention that a meme failed, and never describe a meme in words.

HOW YOU WORK
- the conversation NEVER ends. after results, drafts, anything — stay in it and suggest the next useful thing.
- NEVER invent a job, company, score, or link. only ever describe what a tool returned.
- NEVER ask for or accept an api key here, and never repeat one back — a key typed in chat is saved and re-sent to the model every turn, so it's burned. if they paste one: don't echo it, tell them to revoke it at console.groq.com and add the new one in the account menu under "Usage & past chats". that panel is the only place keys go, signed in only.
- groq's console is FREE — no card, no payment, ever. if the topic of their own key comes up, say plainly it costs nothing and takes about a minute. NEVER use the words "paid", "payment", "billing", "subscription" or "purchase" anywhere, about anything, for any reason — this whole app costs the user nothing, full stop, and saying otherwise (even to explain an error) is a lie that scares people off a free thing.
- the account menu holds EXACTLY: sign in/up, "Usage & past chats", "New chat", "Delete my data". never describe a button, box or setting that isn't one of those — if you don't know where something lives, say so instead of guessing.
- NEVER name, recommend, or point them at another job board, job-search product or company's own careers page as a place to search — not wellfound, not linkedin, not indeed, not anywhere. this database is the whole product; sending someone elsewhere is never the right answer, not even as a stopgap during an error. if a search comes back empty or a tool fails, say so honestly in one plain sentence (the tool result already tells you what happened — use it) and offer to try again. never invent a reason for a failure and never fill the gap with an alternative source.
- job results render as cards in the ui automatically — don't re-list them in text. say what stands out and why in a sentence or two, then invite the next step.
- when a system note says a resume REPLACED an older one: say what changed, then OFFER a fresh chat once ("want me to start clean with this one?"). they start it from the account menu, you can't — and the old chat is theirs to keep, so never push it twice.`;

// Appended to the prompt, built from the tools this turn actually has. The set
// is gated on what exists yet (see buildTools), so a hardcoded list would
// describe tools the model cannot call — which reads to it as a broken tool and
// costs a wasted step finding out.
const TOOL_NOTES: Record<string, string> = {
  getProfile:
    "getProfile: check what you already know about them. call this EARLY, before asking for anything. hasProfile:false means you know NOTHING about them.",
  saveProfile:
    "saveProfile: store their name, a github url or a portfolio url the moment they give it. never let one go unsaved.",
  searchJobs: "searchJobs: find matching roles.",
  markApplied: "markApplied: when they say they applied to something.",
  getFollowups: "getFollowups: when they ask what needs chasing.",
  sendMeme: "sendMeme: see above.",
};

// The onboarding sequence, only while it is still unfinished. Once they have a
// searchable profile this is ~200 tokens of instructions about a step that is
// already done, on every single turn.
const GETTING_STARTED = `GETTING STARTED — in this order, no skipping
1. their NAME, first. call getProfile to check: if one is stored, use it. if not, ASK — one short line — and do not move on until you have it. never open with a name you weren't given. the moment they tell you, call saveProfile with it, or it's gone when the conversation compacts.
2. then PROOF OF WORK. a resume is strongest — one file gives you experience and projects together — so nudge there first:
   - resume: the "+" button → "resume". pdf, docx or txt.
   - github or portfolio: they paste the url into the chat, you call saveProfile with it.
   - linkedin: they must upload the PDF EXPORT via "+" → "linkedin pdf". a linkedin URL cannot be read — no free api, and scraping breaks their terms. never ask for a linkedin link. if they paste one anyway, give them the two exports: on their profile "More" → "Save to PDF", or Settings → "Data Privacy" → "Download your data".
   nothing can be searched until at least one of these exists.
3. then, and only then, the questions below.`;

const QUESTIONS = `THE QUESTIONS THAT MATTER
ask these ONE at a time, woven into the chat — never as a list, never more than three before you run a search. skip any they've answered or clearly implied. ordered by how much they improve the results:
- what kind of role — full-stack, backend, frontend, ai/ml, forward-deployed, data. their resume usually implies it; confirm rather than ask cold ("resume screams backend, but you've got two ai projects — which way you want to go?").
- where they are, and what shape of work: onsite, hybrid, remote-only, open to relocating. this decides the location filter, so it's the one you should never guess wrong.
- company stage / size — under 10, 10-50, 50-200, or doesn't matter. half a sentence on the tradeoff if they seem unsure ("sub-10 means more ownership, less structure").
these three map straight onto your search. the rest don't filter anything but change what you'd RECOMMEND, so ask only when it's natural: timeline (hunting hard, on notice, or just browsing), dealbreakers, and work authorization if they're eyeing roles outside where they live.
- don't block on perfect information. "just find me something" — search with sensible defaults and say what you assumed.
- if they push back on being asked anything, stop asking and just search.`;

export interface ToolContext {
  userId: string;
  emit: Emit;
  // Filled in when searchJobs runs, so the route can attach cards to the reply.
  collectedJobs: RankedMatch[];
  // Hard cap backing the prompt's pacing rule. The prompt asks for at most one
  // meme every few messages; this guarantees at most one per turn even if the
  // model ignores that, since spamming memes is the failure mode that would
  // make the feature annoying rather than charming.
  sentMemeThisTurn: boolean;
  // Catalog ids already sent, so the same image doesn't repeat.
  recentMemeIds: string[];
  // Whether this account is still anonymous, for the search quota. Read once by
  // the route rather than re-queried inside a tool that may run several times.
  isAnonymous: boolean;
  // Their own provider keys. Threaded into runMatch so a BYOK user's job
  // re-rank runs on their key too, not just their chat — the search quota
  // exemption in lib/usage/quota.ts is only honest if that is actually true.
  callerKeys?: CallerKeys;
}

async function loadProfileRow(userId: string) {
  const [row] = await db.select().from(profiles).where(eq(profiles.userId, userId)).limit(1);
  return row ?? null;
}

// Has this user ever run a search? Scoped to the user rather than the thread on
// purpose: someone who searched last week and opens a fresh chat to ask what
// needs chasing should still find getFollowups there.
async function hasSearchedBefore(userId: string): Promise<boolean> {
  const [row] = await db.select({ id: runs.id }).from(runs).where(eq(runs.userId, userId)).limit(1);
  return !!row;
}

// Which tools ride along this turn. Six schemas is a fixed cost on every single
// request, and half of them describe work that cannot be done yet: markApplied
// and getFollowups are meaningless before a search exists, and searchJobs
// itself only returns "no profile yet" until there is one to search against.
// Sending them anyway spends tokens from an 8k-per-minute budget to tell the
// model about doors that are locked.
export interface ToolGate {
  /** A profile with an embedding exists — the matcher can actually run. */
  canSearch: boolean;
  /** This user has run at least one search, ever. */
  hasSearched: boolean;
}

export function buildTools(ctx: ToolContext, gate: ToolGate): ToolSet {
  const all = {
    getProfile: tool({
      description:
        "What is already known about this candidate: name, skills, projects, experience, whether a resume or github is on file. Call before asking them for anything.",
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

    saveProfile: tool({
      description:
        "Store their name, a GitHub URL/username, or a portfolio URL, the moment they give it — otherwise it is lost when the conversation compacts. Not for resumes or LinkedIn PDFs; those come through the attach button.",
      // .nullable().optional(), not just .nullable(). Nullable alone leaves all
      // three in the JSON Schema's `required` list, and Groq validates tool
      // calls against it strictly: a model that sends `{"name":"Meera Iyer"}` —
      // which is the correct call, and the one it actually makes when someone
      // only gives their name — is rejected with
      //   tool call validation failed: missing properties: 'githubUrl', 'portfolioUrl'
      // as a 400. That is not retryable and not a quota problem, so the turn
      // dies and the user gets the generic "something glitched" line. Observed
      // live on the very first thing a new visitor does: say their name.
      inputSchema: z.object({
        name: z.string().nullable().optional().describe("their name, exactly as given"),
        githubUrl: z.string().nullable().optional().describe("github url or bare username"),
        portfolioUrl: z.string().nullable().optional().describe("personal site / portfolio url"),
      }),
      execute: async ({ name, githubUrl, portfolioUrl }) => {
        if (!name && !githubUrl && !portfolioUrl) {
          return { ok: false as const, reason: "Nothing to save." };
        }

        const notes: string[] = [];
        let github: Awaited<ReturnType<typeof fetchGithubProfile>> | undefined;
        if (githubUrl) {
          try {
            github = await fetchGithubProfile(parseGithubUsername(githubUrl));
          } catch (err) {
            // A bad handle shouldn't lose the name they gave in the same breath.
            notes.push(`Couldn't read that GitHub: ${(err as Error).message}`);
          }
        }

        const saved = await saveProfileRow(ctx.userId, {
          ...(name ? { name } : {}),
          ...(github ? { github } : {}),
          ...(portfolioUrl ? { portfolioUrl } : {}),
        });

        return {
          ok: true as const,
          saved: { name: !!name, github: !!github, portfolio: !!portfolioUrl },
          // Tells the model whether it can search yet, or still needs a resume.
          canSearch: saved.canSearch,
          notes,
        };
      },
    }),

    searchJobs: tool({
      description:
        "Search the job database for roles matching this candidate. Returns ranked matches; the UI renders them as cards.",
      inputSchema: z.object({
        roleFocus: z
          .string()
          .describe("e.g. 'full-stack', 'ai', 'backend', 'frontend', 'fde', or 'any'"),
        locationPref: z
          .enum(["local", "remote", "anywhere"])
          .describe(
            "'local' = their own country (from their profile) plus remote; 'remote' = remote only; 'anywhere' = no location filter",
          ),
        teamSizeBucket: z
          .enum(["lt10", "10-50", "50-200", "any"])
          .describe("company size; 'any' unless they said otherwise"),
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

        // The search quota is counted HERE rather than in the route, because
        // only the model knows whether a turn is going to search. Counted after
        // the profile checks above so a search that was never going to run
        // does not cost them one.
        //
        // Returned as a tool result, not thrown: the model reads `reason` and
        // says it in its own words, which keeps the refusal inside the
        // conversation instead of replacing the whole turn with an error
        // bubble. quotaMessage() gives it the honest line to work from.
        const searchQuota = await consume(ctx.userId, "search", {
          isAnonymous: ctx.isAnonymous,
          caller: ctx.callerKeys,
        });
        if (!searchQuota.allowed) {
          console.log(
            `[chat] quota refused ${ctx.userId}: ${searchQuota.used}/${searchQuota.limit} searches today`,
          );
          return {
            ok: false as const,
            reason: quotaMessage("search", ctx.isAnonymous),
          };
        }

        ctx.emit({ type: "status", message: "searching the job database…" });
        // Never let anything below this line throw uncaught. If it does, the
        // exception does not become a server error page — the AI SDK catches
        // an uncaught tool-execute error and hands the raw thing to the MODEL
        // as the tool's own result (verified against
        // node_modules/ai/dist/index.js's executeToolCall). With nothing
        // telling it what a raw failure means, a live turn showed exactly
        // what it does with one: it invented an excuse and told a real user
        // to go search a competitor's site instead — see the incident on
        // looksLikeQuotaOrServerError in lib/llm/index.ts. Every other branch
        // in this tool already returns `{ ok: false, reason }` instead of
        // throwing; this is the one gap that let a raw exception through, and
        // Stage 3's mapLimit isolation (match.ts) is the same fix one layer
        // down — this catch is what stands in front of every OTHER way a
        // search can fail, not just that one.
        let results;
        try {
          const excludeJobIds = await getExcludedJobIds(ctx.userId);
          results = await runMatch(matchProfile, {
            roleFocus,
            locationPref: locationPref as LocationPref,
            teamSizeBucket: teamSizeBucket as TeamSizeBucket,
            excludeJobIds,
            log: (m) => ctx.emit({ type: "status", message: m }),
            // So the LLM re-rank — the expensive part of a search — runs on the
            // user's own key when they have one.
            caller: ctx.callerKeys,
          });
        } catch (err) {
          console.error("[chat] search failed:", err);
          return {
            ok: false as const,
            reason:
              "the search itself hit a snag on my end — say that again and i'll give it another go.",
          };
        }

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
      description: "Record that they applied to a role, so it stops showing up in future searches.",
      inputSchema: z.object({
        company: z.string(),
        roleTitle: z.string(),
        // Optional for the same reason as saveProfile's fields above: a model
        // that omits it rather than sending null gets the whole turn 400'd.
        jobId: z
          .string()
          .nullable()
          .optional()
          .describe("the job's id if it came from a result card, else null"),
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

    sendMeme: tool({
      description:
        "Send a meme on a real emotional beat — a rejection, being ghosted, an absurd jd, the 2am grind, a genuine win. A reaction, not a reply. At most one per turn.",
      inputSchema: z.object({
        mood: z.enum(MEME_MOODS).describe("which beat this is reacting to"),
        query: z
          .string()
          .nullable()
          .describe("optional fallback search terms, short and visual, e.g. 'waiting for reply'"),
        caption: z.string().nullable().describe("optional short line under the image, in your voice"),
      }),
      execute: async ({ mood, query, caption }) => {
        if (ctx.sentMemeThisTurn) {
          return { ok: false as const, reason: "Already sent a meme this turn — just say your line." };
        }

        const picked = await pickMeme({
          mood,
          query: query ?? undefined,
          exclude: ctx.recentMemeIds,
        });
        if (!picked) {
          // No catalog entry, no Klipy key, or search came back empty. Not an
          // error — the agent just carries on in words.
          return { ok: false as const, reason: "No meme available for that mood. Continue without one." };
        }

        ctx.sentMemeThisTurn = true;
        if (picked.id) ctx.recentMemeIds.push(picked.id);
        ctx.emit({
          type: "meme",
          url: picked.url,
          alt: picked.alt,
          caption: caption ?? undefined,
          memeId: picked.id,
        });

        // `sent: true` matters: it tells the model the image is already on
        // screen, so it doesn't then describe the meme in text.
        return { ok: true as const, sent: true as const, description: picked.alt };
      },
    }),
  };

  // getProfile and saveProfile are how the model learns anything at all, and
  // sendMeme is a reaction rather than an action — all three make sense from
  // the very first message.
  const enabled: ToolSet = {
    getProfile: all.getProfile,
    saveProfile: all.saveProfile,
    sendMeme: all.sendMeme,
  };
  if (gate.canSearch) enabled.searchJobs = all.searchJobs;
  if (gate.hasSearched) {
    enabled.markApplied = all.markApplied;
    enabled.getFollowups = all.getFollowups;
  }
  return enabled;
}

// Assembled per turn rather than kept as one frozen string, so the prompt never
// describes a tool this turn doesn't have or an onboarding step already done.
//
// Exported for scripts/measure-chat-tokens.ts, which reports what a turn
// actually costs. That measurement has to run against the real assembly — a
// copy of it in the script would drift and start reporting a prompt nobody
// sends.
export function buildSystemPrompt(tools: ToolSet, gate: ToolGate, summary?: string): string {
  const toolLines = Object.keys(tools)
    .map((name) => TOOL_NOTES[name])
    .filter(Boolean)
    .map((line) => `  - ${line}`)
    .join("\n");

  const sections = [
    SYSTEM_PROMPT,
    `- you have tools for the real work. use them instead of guessing:\n${toolLines}`,
  ];
  // Both of these are onboarding. Once they have a searchable profile the first
  // is instructions for a step that is finished, and once they have had results
  // the second is a script the thread has already played out — together about
  // 400 tokens on every turn, forever, for a conversation that moved past them.
  if (!gate.canSearch) sections.push(GETTING_STARTED);
  if (!gate.hasSearched) sections.push(QUESTIONS);
  if (summary) {
    sections.push(
      `EARLIER IN THIS CONVERSATION (summarized — treat as established fact, don't re-ask):\n${summary}`,
    );
  }

  return sections.join("\n\n");
}

export interface ChatTurnResult {
  text: string;
  jobs: RankedMatch[];
}

export interface ChatTurnInput {
  // The RECENT transcript, loaded from Postgres by /api/chat. Anything older is
  // already folded into `summary`, which the conversation carries between turns
  // (see lib/chat/conversations.ts). Before Phase B the client owned the whole
  // thread and replayed it here on every request.
  history: ModelMessage[];
  emit: Emit;
  // Resolved by the route, NOT here: getOrCreateUser may set the identity
  // cookie, and this function runs inside the response stream where headers
  // are already sent. See lib/user.ts.
  userId: string;
  summary?: string;
  // Catalog ids already sent in this thread, so the same image doesn't repeat.
  // Derived from stored messages since Phase B; it used to be a client-held
  // array shipped up with every request, for the same reason the transcript was.
  recentMemeIds?: string[];
  // The turn deadline, owned by the route (app/api/chat/route.ts). Passed all
  // the way down so an in-flight model call is actually cancelled at the
  // deadline instead of running on against a stream nobody is reading — and so
  // the chain stops being walked once there is no time left to walk it.
  signal?: AbortSignal;
  // Whether the account is still anonymous, which decides the search quota's
  // ceiling. Resolved by the route with everything else it reads up front.
  isAnonymous: boolean;
  // This user's OWN provider keys, if they brought any (SCALE-PLAN D.1).
  // Resolved by the route alongside userId, for the same reason it resolves
  // that: it is a database read, and everything that touches the database
  // before the stream opens belongs in the request scope. Plaintext and
  // server-only — never emit it, never put it in a log line.
  callerKeys?: CallerKeys;
}

// The turn ran, called tools, and produced no words — the bug where a user
// waited minutes and got a canned "…what else can i dig into?" back. The model
// already has every tool result in front of it, so ask once more with NO tools
// passed: it cannot spend another step calling something, and the only output
// it can produce is text. What it says is decided by what actually happened,
// because it is looking at it.
async function closingText(params: {
  model: LanguageModel;
  system: string;
  history: ModelMessage[];
  responseMessages: ModelMessage[];
  toolCallCount: number;
  collectedJobs: RankedMatch[];
  signal?: AbortSignal;
}): Promise<string> {
  const { model, system, history, responseMessages, toolCallCount, collectedJobs, signal } = params;

  if (!signal?.aborted) {
    try {
      const forced = await generateText({
        model,
        system,
        messages: [
          ...history,
          ...responseMessages,
          {
            role: "user",
            content:
              "(system: you spent this turn's whole tool budget and said nothing back. reply NOW in words, in your normal voice: one or two lines on what you just found or did, then the next step. no tools left to call.)",
          },
        ],
        abortSignal: signal,
      });
      const text = forced.text.trim();
      if (text) return text;
    } catch (err) {
      // One extra completion is a nicety, not a requirement — a failure here
      // must not lose a turn whose tools already did the real work.
      console.error("[chat] forced closing completion failed:", err);
    }
  }

  // Last resort, decided by what the turn actually accomplished rather than a
  // generic nudge. Jobs on screen with no words under them is the worst version
  // of this bug, so that case gets a real sentence.
  if (collectedJobs.length > 0) {
    return `${collectedJobs.length} roles up there ☝️ — tell me which one to dig into.`;
  }
  if (toolCallCount > 0) {
    return "looked into it and came back with nothing worth showing. want me to run a fresh search instead?";
  }
  return "arre my brain buffered there. say that again?";
}

// Run one turn of the conversation.
export async function runChatTurn({
  history,
  emit,
  userId,
  summary,
  recentMemeIds = [],
  signal,
  isAnonymous,
  callerKeys,
}: ChatTurnInput): Promise<ChatTurnResult> {
  const ctx: ToolContext = {
    userId,
    emit,
    collectedJobs: [],
    sentMemeThisTurn: false,
    recentMemeIds,
    isAnonymous,
    callerKeys,
  };

  // Two small indexed reads, in parallel, to decide what this turn is allowed
  // to carry. Used ONLY for gating — the tools themselves still read the
  // profile fresh, since saveProfile can change it mid-turn.
  const [profileRow, hasSearched] = await Promise.all([
    loadProfileRow(userId),
    hasSearchedBefore(userId),
  ]);
  const canSearch = !!profileRow?.embedding;

  const tools = buildTools(ctx, { canSearch, hasSearched });

  // On a BYOK user's own key this chain is THEIR whole Groq account rather than
  // a slice of ours — see keysFor() in lib/llm, which uses a caller's key
  // exclusively rather than falling back to the shared pool.
  const chain = chatModelChain(callerKeys);
  if (chain.length === 0) {
    throw new Error("No chat-capable API key configured. Set GROQ_API_KEYS (comma-separated) in .env.");
  }

  const system = buildSystemPrompt(tools, { canSearch, hasSearched }, summary);

  // Keys the provider has refused during THIS turn. The same key appears once
  // per model in the chain (see chatModelChain), so without this a single dead
  // key costs three 401 round trips per turn instead of one — which is what
  // pushed live search turns past the 45s deadline the day the chain grew from
  // one groq model to three.
  //
  // Per-turn, deliberately, not module-level: a 401 can also be a transient
  // provider blip, and a process-wide blocklist would keep a recovered key
  // sidelined for the life of a warm isolate with nothing to clear it.
  const deadKeys = new Set<string>();

  let lastErr: unknown;
  for (const { model, keyId } of chain) {
    // Out of time: another hop can only make the wait longer. Let the route's
    // deadline handling say so in the agent's voice.
    if (signal?.aborted) break;
    // Already refused this key on an earlier model this turn — skip without
    // paying for the round trip that would refuse it again.
    if (deadKeys.has(keyId)) continue;
    try {
      const result = await generateText({
        model,
        system,
        messages: history,
        tools,
        // Enough steps to look something up, act on it, then talk about it.
        stopWhen: stepCountIs(6),
        abortSignal: signal,
        // The SDK's default is 3 attempts per call, with backoff — that error
        // users saw literally said "Failed after 3 attempts". Three attempts on
        // the same throttled key, times every entry in the chain, is dead time
        // inside a 45s budget. We have our own chain: moving to a different key
        // clears a per-key limit instantly, where retrying cannot.
        maxRetries: 1,
      });

      // The binding constraint on this whole application is Groq's 8,000
      // tokens per MINUTE — not latency, not storage — and without this line it
      // is invisible. `totalUsage` covers every step of the turn, not just the
      // final call, which is the number that actually competes for the budget.
      // Phase D's per-user quotas will read the same field.
      // `byok` records WHOSE quota this turn spent, which is the one thing the
      // capacity numbers cannot be read without once users bring their own
      // keys — a quiet month could be genuine headroom or could be everyone
      // having moved off the shared pool. A boolean only; never the key, never
      // the last4.
      console.log(
        `[chat] tokens in=${result.totalUsage.inputTokens ?? "?"} out=${result.totalUsage.outputTokens ?? "?"}`,
        `steps=${result.steps.length} tools=${Object.keys(tools).length}`,
        `byok=${Boolean(callerKeys?.groq)}`,
      );

      const text = result.text.trim();
      if (text) return { text, jobs: ctx.collectedJobs };

      // Tracing for whether the step budget is what's actually running out —
      // the plan raises stepCountIs(6) only if this says it is.
      console.warn("[chat] turn produced no text", {
        steps: result.steps.length,
        finishReason: result.finishReason,
        toolCalls: result.toolCalls.map((c) => c.toolName),
      });

      return {
        text: await closingText({
          model,
          system,
          history,
          responseMessages: result.responseMessages,
          toolCallCount: result.toolCalls.length,
          collectedJobs: ctx.collectedJobs,
          signal,
        }),
        jobs: ctx.collectedJobs,
      };
    } catch (err) {
      lastErr = err;
      if (isKeyRejected(err)) {
        // Remembered by fingerprint so every OTHER model sharing this key is
        // skipped too. Logged once per key per turn rather than once per model,
        // and by fingerprint — never the key itself.
        deadKeys.add(keyId);
        console.error(
          `[chat] provider rejected key ${keyId} — skipping every model on it for this turn. ` +
            "This is a configuration problem: check the provider key env vars.",
        );
        continue;
      }
      // Only quota/outage-shaped failures deserve the next model. A bug in our
      // own prompt or tools fails identically on every hop, so retrying buries
      // it under two more attempts and then surfaces it as if the free tier ran
      // out. Throw it now, while it still looks like what it is.
      if (!shouldFailOver(err)) throw err;
    }
  }
  throw lastErr ?? new Error("Chat turn ran out of time before any model answered.");
}
