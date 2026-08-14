// Account state for the header menu, and the one server-side step the
// anonymous -> Google upgrade needs.
//
// The upgrade itself has to start in the browser, because both linkIdentity()
// and signInWithOAuth() end in a redirect the user has to follow. What the
// browser cannot do is record which account it is leaving behind: users.id is
// server-side state and the sh_uid cookie is httpOnly. Hence POST.

import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/db/schema";
import { getOrCreateUser } from "@/lib/user";
import { AccountNotFoundError, deleteAccount } from "@/lib/account/delete";
import { createClient } from "@/lib/supabase/server";
import { supabaseAuthEnv } from "@/lib/supabase/env";
import { GOOGLE_LINKED_COOKIE, MERGE_FROM_COOKIE } from "@/app/auth/callback/route";

export async function GET() {
  const userId = await getOrCreateUser();
  const [row] = await db
    .select({
      isAnonymous: users.isAnonymous,
      email: users.email,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  // Tells the menu which sign-in leg to try first. See GOOGLE_LINKED_COOKIE's
  // comment in app/auth/callback/route.ts — this is what lets a sign-out then
  // sign-back-in skip the linkIdentity attempt that would only collide and
  // fall back anyway.
  const store = await cookies();
  const hasSignedInBefore = store.get(GOOGLE_LINKED_COOKIE)?.value === "1";

  return Response.json({
    // Lets the menu hide sign-in entirely rather than offering a button that
    // only fails after a round trip to Google.
    authConfigured: !!supabaseAuthEnv(),
    signedIn: row ? !row.isAnonymous : false,
    email: row?.email ?? null,
    displayName: row?.displayName ?? null,
    avatarUrl: row?.avatarUrl ?? null,
    hasSignedInBefore,
  });
}

// Called immediately before the browser starts the Google redirect. Records the
// account being upgraded so app/auth/callback can merge into whatever account
// the user lands in.
//
// Set on BOTH upgrade paths, including linkIdentity, even though linkIdentity
// keeps the same auth uid and therefore needs no merge. That is deliberate: the
// callback compares the two ids and skips when they match, so the cookie costs
// nothing on the common path and is already in place on the one that needs it —
// which is discovered only after Google has redirected, when there is no longer
// an opportunity to set it.
export async function POST() {
  const userId = await getOrCreateUser();

  const store = await cookies();
  store.set(MERGE_FROM_COOKIE, userId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    // Long enough to sign in with Google, short enough that an abandoned
    // attempt cannot merge anything into an account chosen days later.
    maxAge: 10 * 60,
  });

  return Response.json({ ok: true });
}

// The phrase the UI makes them type. Checked here as well as in the dialog: the
// dialog is the affordance, this is the actual gate, and a request that reaches
// this route without it did not come from that dialog.
const CONFIRM_PHRASE = "delete everything";

// "Delete my data" (SCALE-PLAN Phase C.3). Irreversible, and nothing here can
// undo it — see lib/account/delete.ts for what that means for the ordering.
//
// Deliberately takes no user id: the account deleted is always the caller's,
// resolved server-side exactly like every other route. An id in the body would
// be an authorization decision made from a request body, which is Phase 0's
// cross-tenant read with a delete on the end of it.
export async function DELETE(req: Request) {
  const body = (await req.json().catch(() => null)) as { confirm?: unknown } | null;
  const confirm = typeof body?.confirm === "string" ? body.confirm.trim().toLowerCase() : "";
  if (confirm !== CONFIRM_PHRASE) {
    return Response.json({ error: `Type "${CONFIRM_PHRASE}" to confirm.` }, { status: 400 });
  }

  const userId = await getOrCreateUser();

  // Read the cookie jar and build the auth client BEFORE the delete. Both are
  // request-scoped and neither depends on the account still existing, but
  // ordering them first keeps the irreversible step as the last thing that can
  // fail — nothing after it can be retried.
  const store = await cookies();
  const supabase = await createClient();

  let result;
  try {
    result = await deleteAccount(userId);
  } catch (err) {
    if (err instanceof AccountNotFoundError) {
      // getOrCreateUser() just resolved this id, so reaching here means the row
      // vanished between the two — a double-submitted delete, most likely.
      // Nothing is left to delete, so the caller's intent is already satisfied.
      return Response.json({ ok: true, alreadyGone: true });
    }
    console.error("[account] delete failed:", err);
    // The transaction rolled back, so the account is intact. Say so, rather
    // than leaving them believing their data is gone when it is not.
    return Response.json(
      { error: "Couldn't delete the account. Nothing was removed — try again." },
      { status: 500 },
    );
  }

  // Sign out AFTER the rows are gone. The session's auth user has just been
  // deleted, so this can fail against the auth server — it is best-effort, and
  // the explicit cookie clearing below is what actually guarantees this browser
  // does not come back holding a session for an account that no longer exists.
  try {
    await supabase?.auth.signOut();
  } catch (err) {
    console.error("[account] sign-out after delete failed:", err);
  }

  // Every cookie that names the deleted account. sh_uid is the pre-Phase-A
  // identity anchor and would otherwise point at a users row that is gone;
  // sh_google_linked is the "this browser has signed in before" hint, which is
  // no longer true of any account that exists. The sb-* cookies are Supabase's
  // own session chunks — cleared by name because signOut may not have reached
  // the auth server, and a stale session cookie is what would make the next
  // page load fail instead of quietly starting them fresh.
  store.delete("sh_uid");
  store.delete(GOOGLE_LINKED_COOKIE);
  store.delete(MERGE_FROM_COOKIE);
  for (const cookie of store.getAll()) {
    if (cookie.name.startsWith("sb-")) store.delete(cookie.name);
  }

  return Response.json({ ok: true, ...result });
}
