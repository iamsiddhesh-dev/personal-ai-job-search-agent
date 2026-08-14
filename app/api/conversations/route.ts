// Listing and starting chat threads.
//
// The panel calls GET on mount to find the thread to resume. POST is an
// explicit "new chat" — the chat route creates a conversation on its own when a
// first message arrives with no id, so nothing here has to run before someone
// can start typing, and opening the panel and walking away leaves no empty row.

import {
  archiveConversation,
  createConversation,
  listConversations,
  loadOwnedConversation,
} from "@/lib/chat/conversations";
import { getOrCreateUser, UUID_RX } from "@/lib/user";

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

// "New chat" (SCALE-PLAN Phase C.1): retire the thread they were in and hand
// back a fresh one. Reset is CHAT ONLY — profile, applications, matches and
// drafts are deliberately untouched, so the agent still knows who they are and
// does not re-ask for the resume. Delete is a different thing entirely, and
// lives on DELETE /api/account.
//
// `archiveId` is optional because the caller may have nothing to archive yet: a
// visitor who opens the panel and hits "new chat" before typing has no thread.
// Passing the id rather than having the server archive "the most recent one"
// keeps a second tab sitting on an older thread from retiring a thread it isn't
// even showing.
export async function POST(req: Request) {
  const userId = await getOrCreateUser();

  // The body is optional, so an absent or unparseable one is not an error —
  // req.json() throws outright on an empty body.
  const body = (await req.json().catch(() => null)) as { archiveId?: unknown } | null;
  const archiveId = typeof body?.archiveId === "string" ? body.archiveId : null;

  if (archiveId) {
    // A malformed id is a database error against a uuid column, not a miss.
    if (!UUID_RX.test(archiveId)) {
      return Response.json({ error: "Not found." }, { status: 404 });
    }
    // Scoped by userId inside the UPDATE, so a stranger's id cannot be archived
    // by racing a separate ownership check.
    const archived = await archiveConversation(userId, archiveId);

    // False covers three different things and only two of them are errors: not
    // theirs, does not exist, or ALREADY archived. The third is what a
    // double-click produces — both requests carry the same archiveId — and
    // failing it would leave the second click looking broken while the first
    // one's new thread is already waiting. So re-read before deciding, and 404
    // only when the row genuinely isn't theirs. 404 rather than 403 for the
    // same reason /api/drafts returns one: a 403 confirms the id exists.
    if (!archived && !(await loadOwnedConversation(userId, archiveId))) {
      return Response.json({ error: "Not found." }, { status: 404 });
    }
  }

  const id = await createConversation(userId);
  return Response.json({ id });
}
