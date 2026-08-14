// The conversation store. Everything that reads or writes `conversations` and
// `messages` lives here, so the ordering rules that make the rolling summary
// correct are stated once instead of re-derived at each call site.
//
// Before Phase B the transcript was a useRef in ConversationPanel.tsx, replayed
// to a stateless /api/chat on every turn. A refresh, a tab close or the back
// button destroyed it.
//
// Two invariants everything here depends on:
//
//  1. Messages are ordered by `ordinal` and nothing else. conversations.
//     summaryThrough counts messages from the start of the thread, so a
//     reordering — or a tie, which created_at can produce when one turn writes
//     a meme and a reply milliseconds apart — silently changes which messages
//     the summary is believed to cover.
//
//  2. summaryThrough only ever advances when a summary covering exactly that
//     many messages was actually stored. Advancing it optimistically loses
//     messages with no error anywhere; a user just finds the agent has
//     forgotten them.

import { and, asc, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { db } from "@/lib/db";
import { companies, conversations, jobs, matches, messages, runs } from "@/db/schema";
import type { RankedMatch } from "@/lib/agent/match";

export type MessageRole = "user" | "assistant";
export type MessageKind = "text" | "jobs" | "meme";

// UI-only extras, per kind. Deliberately narrow — anything the MODEL needs to
// know belongs in `content`, because that is the only field a turn ever sees.
export type MessageDisplay =
  // 'text'. Present only when the rendered bubble differs from the model-facing
  // text: a resume upload shows "📎 cv.pdf" to the user while the model is told
  // what was actually parsed out of it.
  | { text?: string }
  // 'jobs'. Ids into `matches`, NOT the hydrated cards — see hydrateJobCards.
  | { matchIds?: string[] }
  // 'meme'.
  | { url?: string; alt?: string; caption?: string; memeId?: string };

export interface NewMessage {
  role: MessageRole;
  kind: MessageKind;
  /** Model-facing text. What historyRef used to hold. */
  content: string;
  display?: MessageDisplay;
}

/** A stored message, hydrated for rendering. */
export interface ThreadMessage {
  id: string;
  role: MessageRole;
  kind: MessageKind;
  text: string;
  jobs?: RankedMatch[];
  imageUrl?: string;
  imageAlt?: string;
}

export interface ConversationSummary {
  id: string;
  title: string | null;
  updatedAt: Date;
}

// Titles are only ever shown in a list, and a whole opening paragraph in a
// sidebar is worse than a truncated one.
const TITLE_MAX = 80;

function toTitle(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > TITLE_MAX ? `${clean.slice(0, TITLE_MAX - 1)}…` : clean;
}

/** This user's live threads, newest first. Archived ones are Phase C's. */
export async function listConversations(userId: string): Promise<ConversationSummary[]> {
  return db
    .select({
      id: conversations.id,
      title: conversations.title,
      updatedAt: conversations.updatedAt,
    })
    .from(conversations)
    .where(and(eq(conversations.userId, userId), isNull(conversations.archivedAt)))
    .orderBy(desc(conversations.updatedAt))
    .limit(50);
}

export async function createConversation(userId: string, title?: string): Promise<string> {
  const [row] = await db
    .insert(conversations)
    .values({ userId, title: title ? toTitle(title) : null })
    .returning({ id: conversations.id });
  return row.id;
}

// Ownership check, kept in one place because every route needs it and the cost
// of forgetting it is Phase 0's cross-tenant read all over again. Returns null
// rather than throwing so callers can 404 — a 403 would confirm that the id
// exists, which is exactly what /api/drafts was fixed not to do.
export async function loadOwnedConversation(userId: string, conversationId: string) {
  const [row] = await db
    .select({
      id: conversations.id,
      title: conversations.title,
      summary: conversations.summary,
      summaryThrough: conversations.summaryThrough,
    })
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function appendMessages(conversationId: string, toAppend: NewMessage[]): Promise<void> {
  if (toAppend.length === 0) return;

  // One statement, so the sequence assigns ordinals in array order and a meme
  // can never land after the reply it was a reaction to.
  await db.insert(messages).values(
    toAppend.map((m) => ({
      conversationId,
      role: m.role,
      kind: m.kind,
      content: m.content,
      display: (m.display ?? null) as object | null,
    })),
  );

  await db
    .update(conversations)
    .set({ updatedAt: new Date() })
    .where(eq(conversations.id, conversationId));
}

/**
 * Everything a turn needs that is not the new message itself: the stored
 * summary, and every message not yet folded into it, in order.
 *
 * Reads from `summaryThrough` rather than reading the whole thread and slicing:
 * the folded prefix is already represented by `summary` and re-reading it every
 * turn is exactly the cost this phase exists to remove.
 *
 * The OFFSET is over ROWS, which is why individual messages must never be
 * deleted from a thread — removing one from the middle shifts every later row
 * down and the offset silently starts reading from the wrong place. Deleting a
 * whole conversation is fine; its messages cascade and the count goes too.
 */
export async function loadTurnContext(conversationId: string, summaryThrough: number) {
  return db
    .select({
      id: messages.id,
      role: messages.role,
      kind: messages.kind,
      content: messages.content,
      display: messages.display,
    })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.ordinal))
    .offset(summaryThrough);
}

/**
 * Catalog meme ids already sent in this thread, newest first.
 *
 * This is what `recentMemeIds` used to be: a client-held array shipped up with
 * every request because the server had no session. It is derived from stored
 * messages now, and leaves the request body along with the transcript.
 */
export async function recentMemeIds(conversationId: string, limit = 12): Promise<string[]> {
  const rows = await db
    .select({ display: messages.display })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), eq(messages.kind, "meme")))
    .orderBy(desc(messages.ordinal))
    .limit(limit);

  return rows
    .map((r) => (r.display as { memeId?: string } | null)?.memeId)
    .filter((id): id is string => typeof id === "string");
}

/**
 * Advance the rolling summary. Only ever called with a summary that covers
 * exactly `through` messages, which is what keeps the pair self-consistent:
 * both halves are written in ONE statement, so no reader can ever see a
 * `summaryThrough` that its `summary` does not actually reach.
 *
 * The `<` guard makes the watermark monotonic. Two turns posted to the same
 * conversation at once (two tabs — the composer only serializes within one)
 * both read the same starting point and both fold, and the slower one can land
 * last carrying a LOWER `through`. That does not lose anything, because the
 * messages past it simply stay unfolded and come back in the next window — but
 * it drags the watermark backwards and makes the next turn re-summarize
 * messages an earlier turn already paid for. Re-paying for LLM calls is the
 * exact cost this whole phase exists to remove, so the older write is dropped.
 *
 * Returns false when that happened, which is informational, not an error.
 */
export async function storeSummary(
  conversationId: string,
  summary: string,
  through: number,
): Promise<boolean> {
  const rows = await db
    .update(conversations)
    .set({ summary, summaryThrough: through })
    .where(and(eq(conversations.id, conversationId), lt(conversations.summaryThrough, through)))
    .returning({ id: conversations.id });
  return rows.length > 0;
}

/**
 * Turn stored `matchIds` back into job cards.
 *
 * The cards are not stored inline: a search returns up to 40 hydrated matches,
 * and lib/agent/persist.ts has already written every field of them to `matches`
 * — inlining would duplicate ~40 KB of jsonb per message for data that is
 * already one join away.
 *
 * Scoped through runs.userId, not just the id list. A message can only be read
 * by its owner already, but this is the same join Phase 0 added to /api/drafts
 * after `matchId` alone turned out to be enough to read a stranger's cards, and
 * a second reader of `matches` should not be the one place that check is
 * missing.
 */
export async function hydrateJobCards(userId: string, matchIds: string[]): Promise<RankedMatch[]> {
  if (matchIds.length === 0) return [];

  const rows = await db
    .select({
      matchId: matches.id,
      score: matches.score,
      breakdown: matches.breakdown,
      leadProof: matches.leadProof,
      leadProofType: matches.leadProofType,
      standoutProject: matches.standoutProject,
      gaps: matches.gaps,
      rationale: matches.rationale,
      jobId: jobs.id,
      title: jobs.title,
      location: jobs.location,
      isRemote: jobs.isRemote,
      applyUrl: jobs.applyUrl,
      source: jobs.source,
      company: companies.name,
      teamSize: companies.teamSize,
      ycBatch: companies.ycBatch,
    })
    .from(matches)
    .innerJoin(runs, eq(matches.runId, runs.id))
    .innerJoin(jobs, eq(matches.jobId, jobs.id))
    .innerJoin(companies, eq(jobs.companyId, companies.id))
    .where(and(inArray(matches.id, matchIds), eq(runs.userId, userId)));

  const byId = new Map(
    rows.map((r) => {
      const breakdown = (r.breakdown ?? {}) as { vectorScore?: number; hiringSignal?: string };
      const card: RankedMatch = {
        matchId: r.matchId,
        jobId: r.jobId,
        title: r.title,
        company: r.company,
        location: r.location,
        isRemote: r.isRemote ?? false,
        applyUrl: r.applyUrl,
        teamSize: r.teamSize,
        ycBatch: r.ycBatch,
        source: r.source,
        score: r.score ?? 0,
        vectorScore: breakdown.vectorScore ?? 0,
        leadProof: r.leadProof ?? "",
        leadProofType: r.leadProofType === "project" ? "project" : "experience",
        standoutProject: r.standoutProject,
        gaps: r.gaps ?? [],
        rationale: r.rationale ?? "",
        hiringSignal: breakdown.hiringSignal === "verified" ? "verified" : "inferred",
      };
      return [r.matchId, card];
    }),
  );

  // Rebuilt in the stored order, which is the score order the user saw. A row
  // that has gone missing is dropped rather than faked — the surrounding reply
  // stays, so the thread reads as it did, just with fewer cards.
  return matchIds.map((id) => byId.get(id)).filter((c): c is RankedMatch => !!c);
}

/**
 * A whole thread, hydrated for rendering. This is what replaces "the client
 * kept it in a ref": on mount, and after every reload, the thread comes from
 * here.
 */
export async function loadThread(userId: string, conversationId: string): Promise<ThreadMessage[]> {
  const rows = await db
    .select({
      id: messages.id,
      role: messages.role,
      kind: messages.kind,
      content: messages.content,
      display: messages.display,
    })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.ordinal));

  // One query for every card in the thread rather than one per message.
  const allMatchIds = rows.flatMap((r) =>
    r.kind === "jobs" ? ((r.display as { matchIds?: string[] } | null)?.matchIds ?? []) : [],
  );
  const cards = await hydrateJobCards(userId, allMatchIds);
  const cardById = new Map(cards.map((c) => [c.matchId as string, c]));

  return rows.map((r) => {
    const display = (r.display ?? {}) as {
      text?: string;
      matchIds?: string[];
      url?: string;
      alt?: string;
      caption?: string;
    };
    const role: MessageRole = r.role === "assistant" ? "assistant" : "user";

    if (r.kind === "jobs") {
      return {
        id: r.id,
        role,
        kind: "jobs" as const,
        text: "",
        jobs: (display.matchIds ?? [])
          .map((id) => cardById.get(id))
          .filter((c): c is RankedMatch => !!c),
      };
    }

    if (r.kind === "meme") {
      return {
        id: r.id,
        role,
        kind: "meme" as const,
        // The caption, not the model-facing "(sent a meme: …)" line.
        text: display.caption ?? "",
        imageUrl: display.url,
        imageAlt: display.alt,
      };
    }

    return {
      id: r.id,
      role,
      kind: "text" as const,
      // display.text is the render override — without it a resume upload would
      // come back after a reload as the "(system: i uploaded my resume…)"
      // narration the model was given, instead of the "📎 cv.pdf" the user sent.
      text: display.text ?? r.content,
    };
  });
}

/** Set the title from the first user message, if this thread has none yet. */
export async function ensureTitle(conversationId: string, text: string): Promise<void> {
  const title = toTitle(text);
  if (!title) return;
  await db
    .update(conversations)
    .set({ title })
    .where(and(eq(conversations.id, conversationId), isNull(conversations.title)));
}
