// Where Google sends the user back to, for both flows: linkIdentity() on the
// anonymous session (the normal upgrade) and signInWithOAuth() (the fallback,
// when that Google account is already an auth user).
//
// This route is also the only place both identities are known at once, so the
// merge has to happen here. See lib/account/merge.ts.

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { applyIdentityProfile, getOrCreateUser, UUID_RX } from "@/lib/user";
import { mergeUsers } from "@/lib/account/merge";

// Set by the client just before it starts the signInWithOAuth fallback, holding
// the users.id of the anonymous account being left behind. A cookie rather than
// OAuth state because the round trip goes through Google and comes back to a
// fresh server context with nothing else carried over.
export const MERGE_FROM_COOKIE = "sh_merge_from";

// Set once, on every successful sign-in, and deliberately never cleared —
// including by sign-out. Lets AccountMenu skip straight to signInWithOAuth
// instead of trying linkIdentity first on a later sign-in from this browser.
//
// Without this: sign-out clears the session, so the next getOrCreateUser()
// mints a fresh anonymous account, and clicking sign-in tries linkIdentity()
// on THAT — which collides with the Google identity already linked to the
// account this browser signed out of, and only then falls back. Every
// ordinary sign-out -> sign-back-in paid for a redirect to Google that was
// always going to fail. This cookie lets that case skip straight to the
// hop that actually works.
//
// Purely an optimization hint, never a security boundary. Read back in
// app/api/account/route.ts's GET. Stale or wrong in either direction costs
// nothing but a redundant round trip: a false positive just means
// signInWithOAuth runs instead of linkIdentity for someone who happened to
// clear this one cookie but not others, which still signs them in correctly
// via the existing merge path.
export const GOOGLE_LINKED_COOKIE = "sh_google_linked";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");

  // Supabase redirects failures back here as query params rather than a non-2xx
  // status. identity_already_exists is the expected one — it is how the
  // linkIdentity path discovers it needs the fallback — so it is handled by the
  // client, not treated as broken here.
  const error = url.searchParams.get("error_code") ?? url.searchParams.get("error");
  if (error) {
    console.error("[auth/callback] provider returned an error:", error, url.searchParams.get("error_description"));
    return NextResponse.redirect(new URL(`/?auth_error=${encodeURIComponent(error)}`, url.origin));
  }

  if (!code) {
    return NextResponse.redirect(new URL("/?auth_error=missing_code", url.origin));
  }

  const supabase = await createClient();
  if (!supabase) {
    // Auth is not configured at all, so there is no session to exchange into.
    // Reachable only if the env vars went missing between the sign-in starting
    // and the redirect coming back.
    return NextResponse.redirect(new URL("/?auth_error=not_configured", url.origin));
  }

  // auth-js 2.112 supports scoping the exchange to a specific PKCE flow. The
  // reserved sb_flow_id param only arrives when appendPkceFlowIdToRedirects is
  // on, so pass it when present and let the client fall back to its single
  // stored verifier when it is not.
  const flowId = url.searchParams.get("sb_flow_id");
  const { data: exchangeData, error: exchangeError } = await supabase.auth.exchangeCodeForSession(
    code,
    flowId ? { flowId } : undefined,
  );

  if (exchangeError) {
    console.error("[auth/callback] exchangeCodeForSession failed:", exchangeError.message);
    return NextResponse.redirect(new URL("/?auth_error=exchange_failed", url.origin));
  }

  const store = await cookies();
  const mergeFrom = store.get(MERGE_FROM_COOKIE)?.value;

  // Resolve the signed-in account BEFORE clearing anything. On the linkIdentity
  // path this is the same users row as before the redirect — same auth uid, so
  // nothing to merge, which is the whole reason linkIdentity is tried first.
  const userId = await getOrCreateUser();

  // exchangeCodeForSession's own response is the ONLY place identities[] is
  // available for free — getClaims()'s JWT, which getOrCreateUser() reads, does
  // not carry it, and a name/avatar entered via Google only ever lands in
  // identity_data, not in user_metadata, on this path. See lib/user.ts. Never
  // block or fail the sign-in on this: a missing name/avatar is cosmetic, an
  // unusable session is not.
  try {
    await applyIdentityProfile(userId, exchangeData.user.identities);
  } catch (err) {
    console.error("[auth/callback] applyIdentityProfile failed:", err);
  }

  if (mergeFrom && UUID_RX.test(mergeFrom) && mergeFrom !== userId) {
    try {
      const result = await mergeUsers(mergeFrom, userId);
      if (!result.merged) {
        // Not fatal: the user is signed into the right account either way, they
        // just may not see what they did anonymously on this device. Worth a
        // log line because every reason here means something upstream is wrong.
        console.error("[auth/callback] merge skipped:", result.reason, { mergeFrom, userId });
      } else {
        console.log("[auth/callback] merged anonymous account", {
          mergeFrom,
          userId,
          ...result,
        });
      }
    } catch (err) {
      // A failed merge must not block the sign-in. The anonymous row is still
      // intact and still holds the data, so this is recoverable; a redirect
      // loop or a 500 on the callback would not be.
      console.error("[auth/callback] merge failed:", err);
    }
  }

  if (mergeFrom) store.delete(MERGE_FROM_COOKIE);

  // Reached only after a real session exists (exchangeCodeForSession above
  // succeeded), so this browser has now completed a Google sign-in at least
  // once. See the constant's comment for why this survives sign-out.
  store.set(GOOGLE_LINKED_COOKIE, "1", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ONE_YEAR_SECONDS,
  });

  const next = url.searchParams.get("next");
  // Only ever redirect to a path on this origin. `next` arrives from the URL,
  // so accepting an absolute one would turn this route into an open redirect
  // that borrows the credibility of a login flow.
  const destination = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
  return NextResponse.redirect(new URL(destination, url.origin));
}
