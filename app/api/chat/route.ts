// Conversational chat endpoint. Takes the transcript so far, runs one agent
// turn, and streams newline-delimited JSON back — the same wire format
// /api/run already uses, so the client parses both the same way.
//
// Events: {type:"status"} while a tool works, {type:"jobs"} for result cards,
// {type:"meme"} for a reaction image, {type:"text"} for the agent's reply,
// {type:"error"} if the turn fails.
//
// Stateless by design: the client owns the thread and sends it each turn, so a
// conversation is never "finished" server-side and can continue indefinitely.

import type { ModelMessage } from "ai";
import { runChatTurn, type AgentEvent } from "@/lib/chat/agent";
import { agentErrorMessage } from "@/lib/chat/errors";
import { summarizeTurns } from "@/lib/chat/summarize";
import { getOrCreateUser } from "@/lib/user";

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
  messages?: { role: "user" | "assistant"; content: string }[];
  // Curated meme ids the client has already been shown this conversation.
  recentMemeIds?: string[];
}

// The client resends the WHOLE thread every turn (server is stateless), but
// replaying all of it into the model forever means cost grows with every
// message — on an 8000 TPM key that eventually prices itself out of a reply.
// Past this many messages, everything older is compacted into a short prose
// summary (see lib/chat/summarize.ts) and only the summary + the most recent
// RAW_KEEP messages go to the actual chat model — flat cost regardless of how
// long the conversation runs, instead of unboundedly growing.
const RAW_KEEP = 12;

export async function POST(req: Request) {
  const deadlineAt = Date.now() + TURN_DEADLINE_MS;
  const body = (await req.json()) as ChatRequest;
  const incoming = (body.messages ?? []).filter(
    (m) => typeof m.content === "string" && m.content.trim().length > 0,
  );

  if (incoming.length === 0) {
    return Response.json({ error: "messages is required." }, { status: 400 });
  }

  const asModelMessages = (msgs: typeof incoming): ModelMessage[] =>
    msgs.map((m) => ({ role: m.role, content: m.content }));

  let history: ModelMessage[];
  let summary: string | undefined;
  if (incoming.length > RAW_KEEP) {
    const older = incoming.slice(0, -RAW_KEEP);
    history = asModelMessages(incoming.slice(-RAW_KEEP));
    try {
      summary = await summarizeTurns(asModelMessages(older));
    } catch {
      // Summarization is an optimization, not a requirement — if it fails,
      // fall back to just the recent window with no summary rather than
      // failing the whole turn over it.
    }
  } else {
    history = asModelMessages(incoming);
  }

  // Resolved before the stream opens: getOrCreateUser may set the identity
  // cookie, and HTTP won't accept a Set-Cookie once the body starts streaming.
  const userId = await getOrCreateUser();
  const recentMemeIds = (body.recentMemeIds ?? []).filter((id) => typeof id === "string");

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // Past the deadline the stream is closed but the abandoned turn may still
      // be inside a tool and try to emit; enqueueing on a closed controller
      // throws. Drop those instead — nobody is reading.
      let closed = false;
      const send = (event: AgentEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };
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
        recentMemeIds,
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
        send({ type: "text", message: text });
      } catch (err) {
        // The real error goes to the server log; the user gets one line in the
        // agent's voice. A provider's message must never reach a chat bubble.
        send({ type: "error", message: agentErrorMessage(err, "turn failed") });
      } finally {
        clearTimeout(timer);
        abort.abort();
        closed = true;
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" },
  });
}
