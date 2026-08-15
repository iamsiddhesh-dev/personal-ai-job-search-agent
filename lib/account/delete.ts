// Deleting an account and everything attached to it (SCALE-PLAN Phase C.3).
//
// This is the only irreversible operation in the codebase. There is no undo, no
// soft-delete column and no backup to restore from, so the rules it follows are
// stricter than anything else here:
//
//  1. Nothing is deleted that is not this user's. `jobs` and `companies` are the
//     shared catalog every user matches against, and `llm_cache` is keyed by a
//     hash of the exact prompt — none of them are user-scoped and none of them
//     are reachable from here. A delete that took the catalog with it would end
//     the site for everybody.
//  2. The row deletes are ONE transaction. A half-deleted account is worse than
//     an untouched one: rows pointing at a `users` row that no longer exists,
//     which every FK here is NO ACTION precisely to prevent.
//  3. Anything needed after a row is gone is read BEFORE it goes. `authUserId`
//     is the whole example — it lives on the row being deleted and the Supabase
//     auth user cannot be found without it.
//
// Why an ordered delete rather than ON DELETE CASCADE on the user-scoped FKs,
// which SCALE-PLAN also floated: lib/account/merge.ts deliberately RELIES on
// those constraints failing loudly. Its final step deletes the anonymous
// `users` row, and a foreign-key violation there is what would catch a merge
// that forgot to re-point profiles, runs, applications or conversations first.
// Under cascade that same bug silently deletes the user's data instead of
// erroring. Trading a loud failure in the merge path for a shorter delete
// statement here is a bad trade, so the constraints stay NO ACTION and this
// file does the ordering by hand — see scripts/migrate-conversations.ts, which
// says the same thing about conversations.user_id.

import { count, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  applications,
  conversations,
  drafts,
  matches,
  messages,
  profiles,
  runs,
  usageCounters,
  userApiKeys,
  users,
} from "@/db/schema";
import { listUserFiles, removeFiles } from "@/lib/storage";
import { adminClient } from "@/lib/supabase/admin";

export interface DeleteAccountResult {
  /** Per-table row counts, for the log line and for verifying the sweep. */
  drafts: number;
  matches: number;
  runs: number;
  conversations: number;
  messagesCascaded: number;
  applications: number;
  profiles: number;
  /** Their own encrypted provider keys (Phase D BYOK). */
  apiKeys: number;
  /** Daily quota counter rows (Phase D). */
  usageRows: number;
  /** Objects removed from the user's `${userId}/` prefix in the resumes bucket. */
  storageObjects: number;
  /**
   * False when the Supabase auth user could not be removed — no auth_user_id on
   * the row (a pre-Phase-A account), the admin client unavailable, or the API
   * call failing. The database rows are gone regardless; see the note at the
   * call site about what a leftover auth user costs.
   */
  authUserDeleted: boolean;
}

export class AccountNotFoundError extends Error {}

/**
 * Delete every row, file and identity belonging to `userId`.
 *
 * Order is deliberate and each step is commented with what it depends on. The
 * database work is transactional; storage and auth are not, and cannot be —
 * they are separate services. Those two run AFTER the commit on purpose: a
 * blob or an auth user left behind is a leak that can still be swept, while a
 * committed storage delete against rows that then failed to commit would take
 * the user's resume away from an account they still have.
 */
export async function deleteAccount(userId: string): Promise<DeleteAccountResult> {
  // Read before anything is destroyed. auth_user_id lives on the row this
  // function is about to delete and there is no other copy of it anywhere —
  // read it afterwards and the Supabase auth user is orphaned permanently.
  const [account] = await db
    .select({ authUserId: users.authUserId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!account) {
    // Nothing to delete, and silence here would report success for an id that
    // was never touched.
    throw new AccountNotFoundError(`No users row for ${userId}.`);
  }

  const counts = await db.transaction(async (tx) => {
    // The two-hop chain first: drafts hang off matches, matches off runs, and
    // runs are the only one of the three that carries a user_id. Collecting the
    // ids up front rather than nesting subqueries keeps each delete readable and
    // gives an exact count per table, which is what the verification in
    // SCALE-PLAN §8 actually checks.
    const runIds = (
      await tx.select({ id: runs.id }).from(runs).where(eq(runs.userId, userId))
    ).map((r) => r.id);

    // inArray() with an empty list is not a no-op in Drizzle — it builds a
    // degenerate condition rather than matching nothing — so every use below is
    // guarded by the list being non-empty.
    const matchIds = runIds.length
      ? (
          await tx.select({ id: matches.id }).from(matches).where(inArray(matches.runId, runIds))
        ).map((m) => m.id)
      : [];

    const deletedDrafts = matchIds.length
      ? (await tx.delete(drafts).where(inArray(drafts.matchId, matchIds)).returning({ id: drafts.id }))
          .length
      : 0;

    const deletedMatches = matchIds.length
      ? (await tx.delete(matches).where(inArray(matches.id, matchIds)).returning({ id: matches.id }))
          .length
      : 0;

    const deletedRuns = runIds.length
      ? (await tx.delete(runs).where(inArray(runs.id, runIds)).returning({ id: runs.id })).length
      : 0;

    // Conversations before profiles only because both must precede `users`;
    // there is no dependency between them. messages.conversation_id is the one
    // FK in the schema that already cascades (Phase B), so a thread's messages
    // go with it and nothing here ever touches an individual message row —
    // which is the constraint Phase B leaves behind: summary_through is a COUNT
    // and loadTurnContext reads the tail with OFFSET, so removing a message
    // from a thread that SURVIVES silently shifts what the agent reads. Whole
    // conversations are safe precisely because the count goes with them.
    const conversationIds = (
      await tx
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.userId, userId))
    ).map((c) => c.id);

    // Counted before the delete, since the cascade returns nothing to count.
    // Reported so "zero rows across user-scoped tables" can be checked against
    // a number rather than assumed from the cascade being configured.
    const messagesCascaded = conversationIds.length
      ? (
          await tx
            .select({ n: count() })
            .from(messages)
            .where(inArray(messages.conversationId, conversationIds))
        )[0].n
      : 0;

    const deletedConversations = conversationIds.length
      ? (
          await tx
            .delete(conversations)
            .where(inArray(conversations.id, conversationIds))
            .returning({ id: conversations.id })
        ).length
      : 0;

    // applications.job_id points AT the shared `jobs` catalog, so deleting
    // applications never reaches it — the arrow runs the wrong way for that.
    const deletedApplications = (
      await tx
        .delete(applications)
        .where(eq(applications.userId, userId))
        .returning({ id: applications.id })
    ).length;

    // After runs, which reference profiles.id and are NOT NULL.
    const deletedProfiles = (
      await tx.delete(profiles).where(eq(profiles.userId, userId)).returning({ id: profiles.id })
    ).length;

    // Their own provider keys (Phase D). This is the one table here whose rows
    // are a credential belonging to someone else's account, so "delete my data"
    // has to mean it — leaving an encrypted Groq key behind for an account that
    // no longer exists is exactly the thing the feature promises not to do.
    // Nothing else references these rows, so the position only has to be before
    // `users`.
    const deletedApiKeys = (
      await tx.delete(userApiKeys).where(eq(userApiKeys.userId, userId)).returning({
        id: userApiKeys.id,
      })
    ).length;

    // Their quota counters (Phase D). Not personal data in any interesting
    // sense — a per-day integer — but the FK is NO ACTION like the rest, so
    // leaving them here would fail the delete below rather than leak anything.
    const deletedUsageRows = (
      await tx.delete(usageCounters).where(eq(usageCounters.userId, userId)).returning({
        action: usageCounters.action,
      })
    ).length;

    // Last. If anything above missed a child row, this is where it fails —
    // loudly, and the whole transaction rolls back with the account intact.
    // That is the entire argument for leaving the FKs at NO ACTION.
    await tx.delete(users).where(eq(users.id, userId));

    return {
      drafts: deletedDrafts,
      matches: deletedMatches,
      runs: deletedRuns,
      conversations: deletedConversations,
      messagesCascaded,
      applications: deletedApplications,
      profiles: deletedProfiles,
      apiKeys: deletedApiKeys,
      usageRows: deletedUsageRows,
    };
  });

  // Storage, after the commit. Lists the PREFIX rather than reading
  // profiles.resumePath, which is the point: uploadResume() writes a new random
  // path on every upload and only the newest was ever stored, so every resume
  // uploaded before Phase C's cleanup is in this bucket referenced by nothing.
  // The column would find one file; the prefix finds all of them.
  let storageObjects = 0;
  try {
    const paths = await listUserFiles(userId);
    storageObjects = await removeFiles(paths);
    if (storageObjects !== paths.length) {
      console.error(
        `[account] storage wipe incomplete for ${userId}: removed ${storageObjects} of ${paths.length}.`,
      );
    }
  } catch (err) {
    // The rows are already gone and cannot come back, so this must not throw:
    // the user's account IS deleted, and reporting failure would invite a retry
    // that now has no account to find. Logged with the id, which is still the
    // storage prefix and therefore all a manual cleanup needs.
    console.error(`[account] could not wipe the storage prefix ${userId}/:`, err);
  }

  // Finally the Supabase auth user. Skipping this leaves an auth user with no
  // `users` row: nothing reads it, so nothing looks broken — but it counts
  // toward the 50,000 MAU free tier forever, and if that same person signs in
  // again getOrCreateUser()'s adoption path finds nothing to adopt and silently
  // starts them over as a new user rather than surfacing the leak.
  let authUserDeleted = false;
  if (account.authUserId) {
    const admin = adminClient();
    if (admin) {
      const { error } = await admin.auth.admin.deleteUser(account.authUserId);
      if (error) {
        console.error(
          `[account] auth user ${account.authUserId} not deleted for ${userId}:`,
          error.message,
        );
      } else {
        authUserDeleted = true;
      }
    }
  }

  const result: DeleteAccountResult = { ...counts, storageObjects, authUserDeleted };
  console.log(`[account] deleted ${userId}`, result);
  return result;
}
