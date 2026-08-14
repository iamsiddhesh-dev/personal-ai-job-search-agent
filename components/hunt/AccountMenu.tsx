"use client";

// The header slot Phase 0 left empty when the border A/B toggle came out.
//
// Deliberately quiet when signed out: SCALE-PLAN asks for the sign-in prompt at
// the moment of value — the first resume upload or first search — never on
// arrival, because the walk-up hero is what people responded to. This is only
// the affordance for someone who goes looking for it.

import { useCallback, useEffect, useRef, useState } from "react";
import { LogOut, User } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { beginGoogle, hasPendingRetry, isSigningIn, setSigningIn } from "@/lib/account/googleSignIn";

type Account = {
  authConfigured: boolean;
  signedIn: boolean;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  // See GOOGLE_LINKED_COOKIE in app/auth/callback/route.ts. True once this
  // browser has ever completed a Google sign-in, survives sign-out.
  hasSignedInBefore: boolean;
};

export function AccountMenu() {
  const [account, setAccount] = useState<Account | null>(null);
  const [open, setOpen] = useState(false);
  // Seeded from sessionStorage, not false: if this render is the page load
  // right after a redirect to Google, the button must read as busy from its
  // very first paint, not flip to busy only once the account fetch below
  // resolves a moment later.
  const [busy, setBusy] = useState(() => isSigningIn());
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/account", { credentials: "same-origin" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: Account | null) => {
        if (cancelled || !data) return;
        setAccount(data);
        // Clear busy only if nothing further is about to redirect the page
        // away again — GoogleAuthRetry (mounted at the app root) checks the
        // same URL param and, if present, will fire another beginGoogle()
        // that re-sets this flag anyway. Clearing it here first would just
        // produce one frame of "idle" between the two hops.
        if (!hasPendingRetry()) {
          setSigningIn(false);
          setBusy(false);
        }
      })
      .catch(() => {
        // A failed account fetch must never take the chat down with it — the
        // menu just stays in its placeholder state.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The identity-exists retry itself is NOT handled here — see
  // components/hunt/GoogleAuthRetry.tsx, mounted at the app root. It has to
  // run regardless of whether the chat panel (and therefore this component)
  // is even mounted, since Google's redirect back always lands on the hero
  // screen. This component only needs to reflect the busy state the retry
  // sets, via isSigningIn()/hasPendingRetry() above.

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const onPrimaryClick = useCallback(async () => {
    if (account?.signedIn) {
      setOpen((v) => !v);
      return;
    }
    setBusy(true);
    // See beginGoogle's comment: a browser that has signed in with Google
    // before skips the doomed linkIdentity attempt and goes straight to a
    // normal sign-in, which the merge cookie set inside beginGoogle still
    // carries the anonymous account's data across from.
    const mode = account?.hasSignedInBefore ? "signin" : "link";
    const failure = await beginGoogle(mode);
    if (failure) {
      setBusy(false);
      console.error("[account] google sign-in failed:", failure);
    }
  }, [account?.signedIn, account?.hasSignedInBefore]);

  const signOut = useCallback(async () => {
    const supabase = createClient();
    if (!supabase) return;
    setBusy(true);
    await supabase.auth.signOut();
    // Full reload rather than a state update: every route resolves identity
    // server-side, so the whole page is stale the moment the session changes.
    window.location.reload();
  }, []);

  // Keeps the title optically centred against the back button while the account
  // state is still loading, and whenever auth is not configured at all.
  if (!account?.authConfigured) return <div aria-hidden className="h-8 w-8" />;

  const label = account.displayName ?? account.email ?? "your account";

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={onPrimaryClick}
        disabled={busy}
        aria-label={account.signedIn ? label : "Sign in with Google to save your chat"}
        aria-haspopup={account.signedIn ? "menu" : undefined}
        aria-expanded={account.signedIn ? open : undefined}
        className="flex h-8 w-8 items-center justify-center overflow-hidden rounded-full bg-bone/10 text-bone hover:bg-bone/20 disabled:opacity-50"
      >
        {account.avatarUrl ? (
          // A Google avatar on an arbitrary googleusercontent host — not worth a
          // remotePatterns entry and a loader round trip for a 32px image.
          // eslint-disable-next-line @next/next/no-img-element
          <img src={account.avatarUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <User size={15} />
        )}
      </button>

      {account.signedIn && open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-2 w-56 overflow-hidden rounded-2xl border border-bone/10 bg-[#16161c] py-1 text-left shadow-xl"
        >
          <p className="truncate px-3 py-2 font-body text-xs text-bone/50">{label}</p>
          <button
            type="button"
            role="menuitem"
            onClick={signOut}
            disabled={busy}
            className="flex w-full items-center gap-2 px-3 py-2 font-body text-sm text-bone/80 hover:bg-bone/10 disabled:opacity-50"
          >
            <LogOut size={14} />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
