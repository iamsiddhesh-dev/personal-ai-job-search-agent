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
import { summarizeTurns } from "@/lib/chat/summarize";
import { getOrCreateUser } from "@/lib/user";

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
      const send = (event: AgentEvent) =>
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      try {
        const { text } = await runChatTurn({ history, emit: send, userId, summary, recentMemeIds });
        // The agent occasionally finishes a tool call with nothing left to say;
        // an empty bubble would look like a bug, so give it a nudge line.
        send({ type: "text", message: text || "…what else can i dig into?" });
      } catch (err) {
        send({ type: "error", message: (err as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" },
  });
}
