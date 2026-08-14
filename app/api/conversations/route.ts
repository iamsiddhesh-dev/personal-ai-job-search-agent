// Listing and starting chat threads.
//
// The panel calls GET on mount to find the thread to resume. POST is an
// explicit "new chat" — the chat route creates a conversation on its own when a
// first message arrives with no id, so nothing here has to run before someone
// can start typing, and opening the panel and walking away leaves no empty row.

import { createConversation, listConversations } from "@/lib/chat/conversations";
import { getOrCreateUser } from "@/lib/user";

export async function GET() {
  const userId = await getOrCreateUser();
  const rows = await listConversations(userId);

  return Response.json({
    conversations: rows.map((c) => ({
      id: c.id,
      title: c.title,
      updatedAt: c.updatedAt.toISOString(),
    })),
  });
}

export async function POST() {
  const userId = await getOrCreateUser();
  const id = await createConversation(userId);
  return Response.json({ id });
}
