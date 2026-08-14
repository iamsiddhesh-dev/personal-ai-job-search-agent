// One thread, hydrated for rendering. This is what the panel loads on mount and
// after every reload, in place of the useRef that used to hold the transcript.

import { loadOwnedConversation, loadThread } from "@/lib/chat/conversations";
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
