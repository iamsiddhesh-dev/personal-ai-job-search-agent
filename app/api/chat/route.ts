// Conversational chat endpoint. Takes ONE new message, runs one agent turn, and
// streams newline-delimited JSON back — the same wire format /api/run already
// uses, so the client parses both the same way.
//
// Events: {type:"conversation"} once, when a thread was just created,
// {type:"status"} while a tool works, {type:"jobs"} for result cards,
// {type:"meme"} for a reaction image, {type:"text"} for the agent's reply,
// {type:"error"} if the turn fails.
//
// Stateful since Phase B. The client used to own the transcript and resend the
// whole thing every turn, which meant a refresh destroyed the conversation and
// every older message was re-summarized from scratch on every single turn. The
// thread now lives in Postgres (lib/chat/conversations.ts) and the request body
// carries only what is new.

import type { ModelMessage } from "ai";
import { runChatTurn, type AgentEvent } from "@/lib/chat/agent";
import {
  appendMessages,
  createConversation,
  ensureTitle,
  loadOwnedConversation,
  loadTurnContext,
  recentMemeIds,
  storeSummary,
  type NewMessage,
} from "@/lib/chat/conversations";
import { agentErrorMessage } from "@/lib/chat/errors";
import { summarizeTurns } from "@/lib/chat/summarize";
import { getOrCreateUser, UUID_RX } from "@/lib/user";

// Vercel Hobby caps a serverless function at 60s, and past that the platform
// kills the request mid-stream with no chance to say anything. The turn budget
// below sits under it deliberately, so the deadline is ours and the user gets a
// sentence instead of a dead connection.
export const maxDuration = 60;

// Nothing here should ever take minutes. Users reported 2-3 minute waits: the
// provider chain walking its retry sleeps, with no ceiling on the total. This
// is that ceiling, and it covers the WHOLE turn — summarization included, since
// that is an LLM call too and it happens before the agent even starts.
const TURN_DEADLINE_MS = 45_000;

interface ChatRequest {
  // Absent on the very first message of a thread; the route creates one and
  // sends the id back as the first stream event.
  conversationId?: string | null;
  message?: string;
  // What the USER should see in place of `message`, when the two differ. Only
  // the resume-upload path uses it: the model is told what was parsed out of
  // the file, the user sees "📎 cv.pdf".
  displayText?: string;
}

// How many raw messages go to the model verbatim. Everything older is folded
// into the conversation's rolling summary, so per-turn cost is flat no matter
// how long the thread runs. Dropped from 12 in Phase B's token diet — the
// summary is now cumulative and actually carries the older context, where the
// old one was rebuilt from scratch and thrown away every turn.
const RAW_KEEP = 8;

// Bounded fallback for the turn where summarization fails. The messages that
// have fallen out of the window are in neither the summary nor the window, so
// sending only RAW_KEEP would quietly drop them; sending everything pending
// would grow without limit if the provider stays down. Twice the window keeps
// the recent past on a bad turn without risking the TPM ceiling, and
// summaryThrough is left alone so the next turn folds them properly.
const DEGRADED_KEEP = RAW_KEEP * 2;

type StreamEvent = AgentEvent | { type: "conversation"; conversationId: string };

type StoredTurn = { role: string; kind: string; content: string };

const toModelMessages = (rows: StoredTurn[]): ModelMessage[] =>
  rows.map((m) => ({
    role: m.role === "assistant" ? ("assistant" as const) : ("user" as const),
    content: m.content,
  }));

// What the model is told about a card it just put on screen. The cards
// themselves are UI, and the tool result already described them in this turn —
// but a RELOADED thread has no tool results in it, so without this line the
// agent comes back to a conversation with results on screen it cannot see.
// Deliberately short: five titles, not forty rows of jsonb.
function jobsLine(jobs: { title: string; company: string }[]): string {
  const named = jobs
    .slice(0, 5)
    .map((j) => `${j.title} @ ${j.company}`)
    .join(", ");
  const rest = jobs.length > 5 ? `, +${jobs.length - 5} more` : "";
  const noun = jobs.length === 1 ? "job card" : "job cards";
  return `(showed ${jobs.length} ${noun}: ${named}${rest})`;
}

export async function POST(req: Request) {
  const deadlineAt = Date.now() + TURN_DEADLINE_MS;
  const body = (await req.json()) as ChatRequest;
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const displayText = typeof body.displayText === "string" ? body.displayText.trim() : "";

  if (!message) {
    return Response.json({ error: "message is required." }, { status: 400 });
  }

  // Resolved before the stream opens: getOrCreateUser may set the identity
  // cookie, and HTTP won't accept a Set-Cookie once the body starts streaming.
  // Everything below it — loading the thread, appending the user turn, rolling
  // the summary — is new Phase B work that runs in the same request scope and
  // must STAY above the ReadableStream for the same reason. None of it touches
  // cookies itself, but inserting the user resolution below any of it would.
  const userId = await getOrCreateUser();

  const requestedId = typeof body.conversationId === "string" ? body.conversationId : null;
  let conversationId: string;
  let priorSummary: string | undefined;
  let summaryThrough = 0;
  let created = false;

  if (requestedId) {
    if (!UUID_RX.test(requestedId)) {
      return Response.json({ error: "Not found." }, { status: 404 });
    }
    // 404 rather than 403 on someone else's thread — a 403 confirms the id
    // exists. Same rule as /api/drafts after Phase 0.
    const conversation = await loadOwnedConversation(userId, requestedId);
    if (!conversation) {
      return Response.json({ error: "Not found." }, { status: 404 });
    }
    conversationId = conversation.id;
    priorSummary = conversation.summary ?? undefined;
    summaryThrough = conversation.summaryThrough;
  } else {
    conversationId = await createConversation(userId, displayText || message);
    created = true;
  }

  // The user's turn is stored BEFORE the agent runs, not after. If the turn
  // fails or the deadline fires, what they typed is still in the thread — the
  // alternative loses their message on exactly the turns that already went
  // badly.
  await appendMessages(conversationId, [
    {
      role: "user",
      kind: "text",
      content: message,
      ...(displayText && displayText !== message ? { display: { text: displayText } } : {}),
    },
  ]);
  if (!created) await ensureTitle(conversationId, displayText || message);

  // Everything not yet folded into the summary, oldest first.
  const pending = await loadTurnContext(conversationId, summaryThrough);

  let summary = priorSummary;
  let history: ModelMessage[];

  if (pending.length > RAW_KEEP) {
    const fold = pending.slice(0, pending.length - RAW_KEEP);
    history = toModelMessages(pending.slice(-RAW_KEEP));
    try {
      const rolled = await summarizeTurns(toModelMessages(fold), priorSummary);
      summary = rolled;
      // Written only once the fold actually succeeded, and with exactly the
      // count it covers. Advancing this without a stored summary that reaches
      // that far is how the agent silently forgets things.
      await storeSummary(conversationId, rolled, summaryThrough + fold.length);
    } catch (err) {
      // Summarization is an optimization, not a requirement. Keep the previous
      // summary, do NOT advance summaryThrough, and widen the raw window so the
      // unfolded messages are not lost from this turn's context entirely.
      console.error("[chat] rolling summary failed, degrading to a wider window:", err);
      history = toModelMessages(pending.slice(-DEGRADED_KEEP));
    }
  } else {
    history = toModelMessages(pending);
  }

  const memeIds = await recentMemeIds(conversationId);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // Past the deadline the stream is closed but the abandoned turn may still
      // be inside a tool and try to emit; enqueueing on a closed controller
      // throws. Drop those instead — nobody is reading.
      let closed = false;
      const enqueue = (event: StreamEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };

      // What this turn produced, appended to the thread once it ends. Collected
      // as events fire rather than reconstructed afterwards, so a turn that
      // dies at the deadline still persists the cards and memes the user
      // actually saw.
      const produced: NewMessage[] = [];

      const send = (event: AgentEvent) => {
        if (event.type === "jobs" && event.jobs) {
          produced.push({
            role: "assistant",
            kind: "jobs",
            content: jobsLine(event.jobs),
            display: {
              // Ids only. persistRun writes every field of a match to the
              // `matches` table already; the cards are rehydrated by joining
              // matches -> jobs -> companies. A result whose persist failed has
              // no matchId and simply will not survive a reload — the same
              // rows that already gate the draft button.
              matchIds: event.jobs
                .map((j) => j.matchId)
                .filter((id): id is string => typeof id === "string"),
            },
          });
        } else if (event.type === "meme" && event.url) {
          produced.push({
            role: "assistant",
            kind: "meme",
            // Without this line the agent has no record of having sent a meme
            // and will send another next turn, which is exactly the spam the
            // pacing rule exists to stop.
            content: `(sent a meme: ${event.alt ?? "reaction image"})`,
            display: {
              url: event.url,
              alt: event.alt,
              caption: event.caption,
              memeId: event.memeId,
            },
          });
        }
        enqueue(event);
      };

      // The client needs the id before it can send a second message, and this
      // is the only place it exists. First event on the wire, deliberately.
      if (created) enqueue({ type: "conversation", conversationId });

      // Two mechanisms, because one isn't enough. The signal cancels an
      // in-flight model call; the race caps the turn even when the time is
      // being spent somewhere a signal can't reach — a slow database query
      // inside a tool, or a provider socket that never answers.
      const abort = new AbortController();
      const remaining = Math.max(1_000, deadlineAt - Date.now());
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          const err = new Error(`Chat turn exceeded ${TURN_DEADLINE_MS}ms.`);
          err.name = "TimeoutError";
          reject(err);
        }, remaining);
      });

      const turn = runChatTurn({
        history,
        emit: send,
        userId,
        summary,
        recentMemeIds: memeIds,
        signal: abort.signal,
      });
      // Whichever side loses the race must not reject unhandled: past the
      // deadline the turn keeps running and will reject on the abort, long
      // after the user has already been told. Still logged — when a turn blows
      // the deadline, why it was slow is the only thing worth knowing.
      turn.catch((err) => console.error("[chat] abandoned turn later failed:", err));

      try {
        const { text } = await Promise.race([turn, deadline]);
        // Empty text is handled inside runChatTurn now, by looking at what the
        // turn actually did — the old canned nudge line here is what users were
        // getting instead of their results.
        enqueue({ type: "text", message: text });
        produced.push({ role: "assistant", kind: "text", content: text });
      } catch (err) {
        // The real error goes to the server log; the user gets one line in the
        // agent's voice. A provider's message must never reach a chat bubble.
        // Deliberately NOT stored: an error line is this request failing, not
        // something the agent said, and replaying it into the model next turn
        // would have it apologising for an outage the user already saw.
        enqueue({ type: "error", message: agentErrorMessage(err, "turn failed") });
      } finally {
        clearTimeout(timer);
        abort.abort();
        try {
          // Awaited before the stream closes. On a serverless platform the
          // isolate can be frozen the moment the response completes, so an
          // un-awaited write here is a write that sometimes does not happen.
          await appendMessages(conversationId, produced);
        } catch (err) {
          // The user has already seen the reply; losing it from history is bad
          // but not worth turning a successful turn into an error.
          console.error("[chat] failed to persist turn:", err);
        }
        closed = true;
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" },
  });
}
