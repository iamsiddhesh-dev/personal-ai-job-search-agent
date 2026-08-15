"use client";

// The header slot Phase 0 left empty when the border A/B toggle came out.
//
// Deliberately quiet when signed out: SCALE-PLAN asks for the sign-in prompt at
// the moment of value — the first resume upload or first search — never on
// arrival, because the walk-up hero is what people responded to. This is only
// the affordance for someone who goes looking for it.
//
// It opens a MENU either way, which it did not originally. Signed out, the
// avatar used to fire the Google redirect straight from the click: one tap on a
// small unlabelled circle and the visitor was on accounts.google.com, with no
// step in between telling them whether they were signing into something they
// already had or making something new. Now both are named, and the destructive
// and reset actions are reachable without an account — an anonymous visitor's
// conversations are real rows in Postgres, so "delete my data" means something
// to them too.

import { useCallback, useEffect, useRef, useState } from "react";
import { Gauge, LogIn, LogOut, MessageSquarePlus, Trash2, User } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { beginGoogle, hasPendingRetry, isSigningIn, setSigningIn } from "@/lib/account/googleSignIn";
import { DeleteAccountDialog } from "./DeleteAccountDialog";
import { NewChatDialog } from "./NewChatDialog";
import { UsagePanel } from "./UsagePanel";

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

interface AccountMenuProps {
  /**
   * Archives the thread on screen and opens a fresh one. Owned by
   * HuntChatFrame, because the panel it swaps is this component's sibling
   * rather than its child.
   */
  onNewChat?: () => Promise<void>;
  /**
   * Opens a named (reopened) thread. Same ownership reason as onNewChat — the
   * usage panel lists archived threads, but the panel that displays one is this
   * component's sibling.
   */
  onOpenThread?: (id: string) => void;
}

export function AccountMenu({ onNewChat, onOpenThread }: AccountMenuProps) {
  const [account, setAccount] = useState<Account | null>(null);
  const [open, setOpen] = useState(false);
  // Seeded from sessionStorage, not false: if this render is the page load
  // right after a redirect to Google, the button must read as busy from its
  // very first paint, not flip to busy only once the account fetch below
  // resolves a moment later.
  const [busy, setBusy] = useState(() => isSigningIn());
  const [confirmingNewChat, setConfirmingNewChat] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [showingUsage, setShowingUsage] = useState(false);
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

  // The avatar opens the menu, signed in or not. It used to fire the Google
  // redirect straight from this click when signed out, which meant one tap on a
  // small unlabelled circle sent people to accounts.google.com with no warning
  // and no way to tell whether they were about to sign in or create something.
  const onPrimaryClick = useCallback(() => setOpen((v) => !v), []);

  // Both entries end at the same Google consent screen and BOTH preserve what
  // the visitor has done so far — that is worth stating, because two buttons
  // side by side imply a consequence to picking wrong and here there is none.
  // "link" upgrades this anonymous session in place, keeping the same auth uid.
  // "signin" mints a session on the existing account and lib/account/merge.ts
  // moves this session's rows onto it, via the cookie beginGoogle sets. The
  // difference is only which leg is tried first; each falls back to the other.
  //
  // Which one is offered as the primary is driven by hasSignedInBefore for the
  // same reason it always was: a browser that has signed in here before would
  // only collide on linkIdentity and fall back anyway.
  const startGoogle = useCallback(async (mode: "link" | "signin") => {
    setBusy(true);
    const failure = await beginGoogle(mode);
    if (failure) {
      setBusy(false);
      console.error("[account] google sign-in failed:", failure);
    }
  }, []);

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
        aria-label={account.signedIn ? label : "Account — sign in or sign up"}
        aria-haspopup="menu"
        aria-expanded={open}
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

      {open && (
        <div
          role="menu"
          className="absolute right-0 z-20 mt-2 w-56 overflow-hidden rounded-2xl border border-bone/10 bg-[#16161c] py-1 text-left shadow-xl"
        >
          <p className="truncate px-3 py-2 font-body text-xs text-bone/50">
            {account.signedIn ? label : "not signed in"}
          </p>

          {/* Signed out: two labelled ways in, rather than one unlabelled
              redirect. Ordered by which leg beginGoogle would have picked
              anyway, so the top entry is the one that costs a single hop. */}
          {!account.signedIn &&
            (account.hasSignedInBefore
              ? ([
                  { mode: "signin" as const, text: "Sign in with Google" },
                  { mode: "link" as const, text: "Sign up with Google" },
                ])
              : ([
                  { mode: "link" as const, text: "Sign up with Google" },
                  { mode: "signin" as const, text: "Sign in with Google" },
                ])
            ).map((item) => (
              <button
                key={item.mode}
                type="button"
                role="menuitem"
                onClick={() => startGoogle(item.mode)}
                disabled={busy}
                className="flex w-full items-center gap-2 px-3 py-2 font-body text-sm text-bone/80 hover:bg-bone/10 disabled:opacity-50"
              >
                <LogIn size={14} />
                {item.text}
              </button>
            ))}

          {!account.signedIn && (
            <p className="border-b border-bone/10 px-3 pb-2 font-body text-xs text-bone/40">
              keeps this chat on your account, on any device.
            </p>
          )}

          {/* Above "New chat" on purpose: it is where the past-chats list
              lives, so someone who has just archived a thread by accident finds
              the way back before they reach the button that did it. Reachable
              without an account for the same reason New chat and Delete are —
              an anonymous visitor has a real quota and real threads. */}
          {onOpenThread && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setShowingUsage(true);
              }}
              disabled={busy}
              className="flex w-full items-center gap-2 px-3 py-2 font-body text-sm text-bone/80 hover:bg-bone/10 disabled:opacity-50"
            >
              <Gauge size={14} />
              {/* Kept short deliberately: at w-56 the longer "Your usage & past
                  chats" wrapped onto a second line while every other entry is
                  one, which made the menu look broken. `whitespace-nowrap` so a
                  future edit that lengthens it fails visibly rather than
                  silently re-wrapping. */}
              <span className="whitespace-nowrap">Usage &amp; past chats</span>
            </button>
          )}
          {onNewChat && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                setConfirmingNewChat(true);
              }}
              disabled={busy}
              className="flex w-full items-center gap-2 px-3 py-2 font-body text-sm text-bone/80 hover:bg-bone/10 disabled:opacity-50"
            >
              <MessageSquarePlus size={14} />
              New chat
            </button>
          )}
          {account.signedIn && (
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
          )}
          {/* Last, separated, and the only red thing in the menu — it sits one
              click below "New chat" and the two must never be mistaken for each
              other. The typed confirmation is in the dialog. */}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setConfirmingDelete(true);
            }}
            disabled={busy}
            className="flex w-full items-center gap-2 border-t border-bone/10 px-3 py-2 font-body text-sm text-red-400 hover:bg-red-500/10 disabled:opacity-50"
          >
            <Trash2 size={14} />
            Delete my data
          </button>
        </div>
      )}

      {confirmingNewChat && onNewChat && (
        <NewChatDialog onConfirm={onNewChat} onClose={() => setConfirmingNewChat(false)} />
      )}
      {confirmingDelete && <DeleteAccountDialog onClose={() => setConfirmingDelete(false)} />}
      {showingUsage && onOpenThread && (
        <UsagePanel onOpenThread={onOpenThread} onClose={() => setShowingUsage(false)} />
      )}
    </div>
  );
}
