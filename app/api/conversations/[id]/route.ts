// One thread, hydrated for rendering. This is what the panel loads on mount and
// after every reload, in place of the useRef that used to hold the transcript.

import {
  loadOwnedConversation,
  loadThread,
  unarchiveConversation,
} from "@/lib/chat/conversations";
import { getOrCreateUser, UUID_RX } from "@/lib/user";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  // A malformed id is a database error against a uuid column, not a miss.
  if (!UUID_RX.test(id)) return Response.json({ error: "Not found." }, { status: 404 });

  const userId = await getOrCreateUser();

  // 404 rather than 403 on someone else's thread, same as /api/drafts after
  // Phase 0: a 403 confirms the id exists.
  const conversation = await loadOwnedConversation(userId, id);
  if (!conversation) return Response.json({ error: "Not found." }, { status: 404 });

  const messages = await loadThread(userId, id);
  return Response.json({ id: conversation.id, title: conversation.title, messages });
}

// Reopen an archived thread (SCALE-PLAN Phase D, the past-chats list).
//
// `{ archived: false }` only — there is no PATCH that archives, because
// archiving is not an isolated act: POST /api/conversations retires the old
// thread and hands back a new one in the same call, and splitting that would
// let a client archive the thread it is sitting in and end up in no thread at
// all.
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) return Response.json({ error: "Not found." }, { status: 404 });

  const userId = await getOrCreateUser();

  const body = (await req.json().catch(() => null)) as { archived?: unknown } | null;
  if (body?.archived !== false) {
    return Response.json({ error: "Only { archived: false } is supported." }, { status: 400 });
  }

  const reopened = await unarchiveConversation(userId, id);

  // Same three-way distinction archiveConversation's caller makes: false means
  // not theirs, nonexistent, or ALREADY live. Only the first two are errors,
  // and a double-click produces the third — so re-read before deciding, and
  // 404 only when the thread genuinely is not theirs.
  if (!reopened) {
    const owned = await loadOwnedConversation(userId, id);
    if (!owned) return Response.json({ error: "Not found." }, { status: 404 });
  }

  return Response.json({ id, reopened });
}
