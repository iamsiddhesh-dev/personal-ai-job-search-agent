// Folding an anonymous account into a real one.
//
// Only needed for one path: a returning user signs in with Google on a second
// device. linkIdentity() keeps the same auth uid and needs no merge at all —
// that is why it is tried first — but it fails outright when that Google
// identity already belongs to another auth user. The fallback signs them into
// the account they already had, which leaves whatever they did anonymously on
// this device stranded on a different `users` row. This moves it across.
//
// Everything here is ordering-sensitive and runs in one transaction, because a
// half-applied merge is worse than no merge: rows pointing at a user row that
// no longer exists, or two profiles on one account.

import { and, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { applications, profiles, runs, users } from "@/db/schema";

export type MergeResult =
  | { merged: false; reason: "same-user" | "source-missing" | "source-not-anonymous" | "target-missing" }
  | { merged: true; movedRuns: number; movedApplications: number; profileKept: "target" | "source" | "none" };

export async function mergeUsers(fromAnonUserId: string, toUserId: string): Promise<MergeResult> {
  // Not a defensive nicety — without this the function would happily re-point
  // every row onto the user it is about to delete, emptying the account it was
  // called to protect.
  if (fromAnonUserId === toUserId) return { merged: false, reason: "same-user" };

  return db.transaction(async (tx) => {
    const [source] = await tx
      .select({ id: users.id, isAnonymous: users.isAnonymous })
      .from(users)
      .where(eq(users.id, fromAnonUserId))
      .limit(1);
    if (!source) return { merged: false, reason: "source-missing" as const };

    // Refuse to dissolve an account that has a real identity attached. The
    // caller passes ids that came out of two different sessions; if the wrong
    // one ever lands in the `from` slot this is the only thing standing between
    // a bug and a signed-in user's data being moved onto a stranger's account.
    if (!source.isAnonymous) return { merged: false, reason: "source-not-anonymous" as const };

    const [target] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, toUserId))
      .limit(1);
    if (!target) return { merged: false, reason: "target-missing" as const };

    // Exactly one profile must survive on the target. loadProfileRow() and
    // saveProfile() both select by user_id with limit(1) and no ORDER BY, so
    // two rows would mean the agent reads an arbitrary one per query — greeting
    // someone by the wrong name on one turn and the right one on the next.
    //
    // The target's own profile wins when it has one, per SCALE-PLAN: they are
    // the established account, and their resume facts are the ones they have
    // been searching against.
    const [targetProfile] = await tx
      .select({ id: profiles.id })
      .from(profiles)
      .where(eq(profiles.userId, toUserId))
      .limit(1);

    const [sourceProfile] = await tx
      .select({ id: profiles.id })
      .from(profiles)
      .where(eq(profiles.userId, fromAnonUserId))
      .limit(1);

    const winner = targetProfile ?? sourceProfile;

    // runs.profile_id is NOT NULL and references profiles.id, so the runs have
    // to be re-pointed at the surviving profile BEFORE the losing one is
    // deleted. Doing it the other way round is a foreign-key violation, which
    // at least fails loudly — but inside a transaction it would roll the whole
    // merge back and the user would just silently keep two accounts.
    const movedRuns = await tx
      .update(runs)
      .set(winner ? { userId: toUserId, profileId: winner.id } : { userId: toUserId })
      .where(eq(runs.userId, fromAnonUserId))
      .returning({ id: runs.id });

    // matches hang off runs.run_id and drafts off matches.match_id, so both
    // follow the runs across without being touched. That two-hop chain is also
    // what the Phase 0 tenancy check joins through, which means those job cards
    // become readable by the target account and stop being readable by the
    // anonymous one — exactly the intent.

    if (winner && winner.id === sourceProfile?.id) {
      await tx.update(profiles).set({ userId: toUserId }).where(eq(profiles.id, winner.id));
    }

    // Anything still on the source. In practice this is the source's profile
    // when the target had one of its own; the app cannot create a second
    // profile per user, but deleting by user_id rather than by a single id
    // means a duplicate that got in some other way cannot survive the merge and
    // reintroduce the ambiguity above. The winner is already off this user by
    // the time this runs, so it is never in scope.
    await tx.delete(profiles).where(eq(profiles.userId, fromAnonUserId));

    const movedApplications = await tx
      .update(applications)
      .set({ userId: toUserId })
      .where(eq(applications.userId, fromAnonUserId))
      .returning({ id: applications.id });

    // Phase B adds `conversations` (and `messages` hanging off it). When it
    // does, re-point conversations here — the delete below will start failing
    // with a foreign-key violation if that is forgotten, which is the failure
    // mode to want.
    await tx.delete(users).where(and(eq(users.id, fromAnonUserId), ne(users.id, toUserId)));

    // The Supabase auth user behind the anonymous session is deliberately left
    // alone: deleting it needs the service-role admin API, and Phase C owns
    // that in lib/account/delete.ts. It is now an auth user with no `users`
    // row, which still counts toward the 50,000 MAU free tier.

    return {
      merged: true as const,
      movedRuns: movedRuns.length,
      movedApplications: movedApplications.length,
      profileKept: targetProfile ? ("target" as const) : sourceProfile ? ("source" as const) : ("none" as const),
    };
  });
}
