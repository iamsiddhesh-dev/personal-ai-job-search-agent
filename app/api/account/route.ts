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
