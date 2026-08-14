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

type Account = {
  authConfigured: boolean;
  signedIn: boolean;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
};

// Module level, and touching no React state on purpose. Every path through it
// ends in a full-page redirect to Google, so there is no component left to
// re-render — and keeping setState out of it is what lets the identity-exists
// fallback below run straight from an effect.
async function beginGoogle(mode: "link" | "signin"): Promise<string | null> {
  const supabase = createClient();
  if (!supabase) return "not_configured";

  // Record which account is being left behind before leaving the page; see
  // app/api/account/route.ts.
  try {
    await fetch("/api/account", { method: "POST", credentials: "same-origin" });
  } catch {
    // Non-fatal: without it a fallback sign-in cannot merge, but the sign-in
    // itself still works and the anonymous data is still in Postgres.
  }

  const redirectTo = `${window.location.origin}/auth/callback`;

  // linkIdentity first, because it keeps the same auth uid — which means the
  // profile, runs and applications already on this account need no migration.
  const { error } =
    mode === "link"
      ? await supabase.auth.linkIdentity({ provider: "google", options: { redirectTo } })
      : await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo } });

  return error ? error.message : null;
}

export function AccountMenu() {
  const [account, setAccount] = useState<Account | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/account", { credentials: "same-origin" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: Account | null) => {
        if (!cancelled && data) setAccount(data);
      })
      .catch(() => {
        // A failed account fetch must never take the chat down with it — the
        // menu just stays in its placeholder state.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The identity-exists fallback. linkIdentity cannot fail fast: the conflict
  // is only discovered once Google has redirected back, so it arrives as a
  // query param on this page rather than as a rejected promise. Retrying as a
  // plain sign-in lands the user in the account they already had, and the merge
  // cookie set before the first attempt is still in the jar, so
  // app/auth/callback folds this device's anonymous work into it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("auth_error") !== "identity_already_exists") return;

    // Strip it first, or a back-navigation re-triggers the whole redirect.
    params.delete("auth_error");
    const query = params.toString();
    window.history.replaceState({}, "", window.location.pathname + (query ? `?${query}` : ""));

    void beginGoogle("signin");
  }, []);

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
    const failure = await beginGoogle("link");
    if (failure) {
      setBusy(false);
      console.error("[account] google sign-in failed:", failure);
    }
  }, [account?.signedIn]);

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
