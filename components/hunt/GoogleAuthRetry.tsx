"use client";

// Mounted once at the app root (see app/layout.tsx) rather than living inside
// AccountMenu, deliberately.
//
// AccountMenu only exists once the chat panel is open, but Google's redirect
// back after an identity-already-exists conflict always lands on `/` — the
// HERO screen, where AccountMenu isn't mounted at all. An effect placed inside
// it never ran. Confirmed live during the Phase A follow-up fix: the
// `auth_error=identity_already_exists` param sat in the URL, unconsumed, for
// 9+ seconds — until manually reopening the chat panel effectively retried it
// by hand, on the next click. That reopen-and-reclick IS the "2-3 attempts"
// that got reported; it was never the fallback logic itself misfiring, it was
// nothing being mounted to run it.
//
// Renders nothing. Its only job is to exist somewhere that is ALWAYS mounted.

import { useEffect } from "react";
import { beginGoogle, hasPendingRetry } from "@/lib/account/googleSignIn";

export default function GoogleAuthRetry() {
  useEffect(() => {
    if (!hasPendingRetry()) return;

    // Strip the param first, or a back-navigation re-triggers the whole
    // redirect.
    const params = new URLSearchParams(window.location.search);
    params.delete("auth_error");
    const query = params.toString();
    window.history.replaceState({}, "", window.location.pathname + (query ? `?${query}` : ""));

    // Retrying as a plain sign-in lands the user in the account they already
    // had, and the merge cookie set before the first attempt is still in the
    // jar, so app/auth/callback folds this device's anonymous work into it.
    void beginGoogle("signin");
  }, []);

  return null;
}
