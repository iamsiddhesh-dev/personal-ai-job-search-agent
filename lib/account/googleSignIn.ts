"use client";

// Shared by AccountMenu.tsx (the button) and GoogleAuthRetry.tsx (the
// always-mounted retry trigger — see that file for why it has to be separate
// from AccountMenu). Kept in one place so both agree on the sessionStorage key
// and the retry-detection logic; two copies drifting apart is how this kind
// of bug happens in the first place.

import { createClient } from "@/lib/supabase/client";

// Persisted rather than kept in React state, because a redirect to Google and
// back is a full page load — component state does not survive it, but
// sessionStorage does (same tab, same origin, which is exactly this flow).
// Without this, the button looks idle and clickable during the ~1-2s the
// browser spends on accounts.google.com, which reads as "nothing happened,
// let me click again."
const SIGNING_IN_KEY = "sh_signing_in";

export function isSigningIn(): boolean {
  try {
    return sessionStorage.getItem(SIGNING_IN_KEY) === "1";
  } catch {
    return false; // sessionStorage can throw in some privacy-mode/embedded contexts
  }
}

export function setSigningIn(value: boolean) {
  try {
    if (value) sessionStorage.setItem(SIGNING_IN_KEY, "1");
    else sessionStorage.removeItem(SIGNING_IN_KEY);
  } catch {
    // Same privacy-mode fallback as isSigningIn — losing the busy indicator
    // across the redirect is cosmetic, not a functional break.
  }
}

// A pending identity-exists retry is discoverable synchronously from the URL.
export function hasPendingRetry(): boolean {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("auth_error") === "identity_already_exists";
}

// Module level, and touching no React state on purpose. Every path through it
// ends in a full-page redirect to Google, so there is no component left to
// re-render — and keeping setState out of it is what lets GoogleAuthRetry run
// this straight from an effect with nothing else to coordinate.
export async function beginGoogle(mode: "link" | "signin"): Promise<string | null> {
  const supabase = createClient();
  if (!supabase) return "not_configured";

  setSigningIn(true);

  // Record which account is being left behind before leaving the page; see
  // app/api/account/route.ts.
  try {
    await fetch("/api/account", { method: "POST", credentials: "same-origin" });
  } catch {
    // Non-fatal: without it a fallback sign-in cannot merge, but the sign-in
    // itself still works and the anonymous data is still in Postgres.
  }

  const redirectTo = `${window.location.origin}/auth/callback`;

  // linkIdentity keeps the same auth uid — no migration needed for a first
  // sign-in from a given browser. But a browser that has signed in with
  // Google before (GOOGLE_LINKED_COOKIE / Account.hasSignedInBefore) skips
  // straight to signInWithOAuth instead: after a sign-out the caller is on a
  // fresh anonymous session, and linkIdentity on that would only collide with
  // the identity already linked to the account this browser signed out of,
  // then fall back anyway. See AccountMenu's onPrimaryClick, which picks
  // `mode` accordingly.
  const { error } =
    mode === "link"
      ? await supabase.auth.linkIdentity({ provider: "google", options: { redirectTo } })
      : await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo } });

  if (error) setSigningIn(false); // not navigating away after all

  return error ? error.message : null;
}
