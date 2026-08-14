// Hard-deletes archived conversations once they are old enough (SCALE-PLAN
// Phase C.1). "New chat" only sets archived_at — the thread and every message
// in it stay exactly where they were, which is what makes reset genuinely
// different from delete. This is what eventually clears them out.
//
// The delay is the whole point of archiving rather than deleting on the spot:
// someone who hits "new chat" and immediately realises they wanted the old
// thread has a month in which their words still exist. Nothing in the UI
// surfaces an archived thread today, so recovery is currently a manual database
// step — but the rows being there at all is what makes it possible.
//
// Deletes CONVERSATIONS, never individual messages. messages.conversation_id is
// ON DELETE CASCADE, so a whole thread's messages go with it and the count in
// conversations.summary_through goes too. Deleting a message out of a thread
// that SURVIVES is the one thing that must never happen here: summary_through
// is a count and loadTurnContext reads the unfolded tail with OFFSET, so
// removing a row from the middle shifts every later one down and the agent
// silently starts reading from the wrong place. See lib/chat/conversations.ts.
//
// Runs from .github/workflows/embed-jobs.yml, which already runs every 6 hours
// against the same DATABASE_URL. Idempotent and cheap — one statement over an
// indexed-by-nothing but tiny table — so running it 4x a day costs nothing and
// means no separate schedule to maintain.

import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

// Overridable so the sweep can be tested against a shorter window without
// editing the file, but the default is the 30 days SCALE-PLAN specifies.
const RETENTION_DAYS = Number(process.env.ARCHIVE_RETENTION_DAYS ?? 30);

async function main() {
  if (!Number.isFinite(RETENTION_DAYS) || RETENTION_DAYS < 1) {
    throw new Error(
      `ARCHIVE_RETENTION_DAYS must be a number >= 1, got ${process.env.ARCHIVE_RETENTION_DAYS}.`,
    );
  }

  // `archived_at IS NOT NULL` is not redundant with the age comparison — it is
  // the entire safety condition. NULL fails the comparison too, so a live
  // thread is never in scope either way, but stating it means a future edit to
  // the interval arithmetic cannot quietly widen this to every old
  // conversation on the site.
  const deleted = await db.execute(sql`
    DELETE FROM conversations
    WHERE archived_at IS NOT NULL
      AND archived_at < now() - make_interval(days => ${RETENTION_DAYS}::int)
    RETURNING id
  `);

  const remaining = await db.execute(sql`
    SELECT count(*)::int AS n FROM conversations WHERE archived_at IS NOT NULL
  `);

  console.log(
    `swept ${deleted.length} archived conversation${deleted.length === 1 ? "" : "s"} ` +
      `older than ${RETENTION_DAYS} days; ` +
      `${(remaining[0] as { n: number }).n} archived thread(s) still inside the window.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
