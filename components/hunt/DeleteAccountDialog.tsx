"use client";

// Typed confirmation for the one irreversible action in the app.
//
// The phrase is not theatre. Everything else destructive here is recoverable —
// "new chat" only archives, a replaced resume only drops the previous file —
// and this is the single control that isn't, so it deliberately cannot be
// triggered by one stray click on a menu item sitting directly under "New chat".
// The server checks the same phrase (app/api/account/route.ts); this dialog is
// the affordance, not the gate.
//
// It also states what SURVIVES, because nothing else in the UI does: the shared
// job catalog is not the user's data and is not theirs to delete, and someone
// who expected "delete everything" to mean the whole database should find that
// out before typing, not after.

import { useEffect, useRef, useState } from "react";

const CONFIRM_PHRASE = "delete everything";

export function DeleteAccountDialog({ onClose }: { onClose: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Escape closes, but never mid-delete: the request is already irreversible by
  // then and dismissing the dialog would just hide what happened to it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const armed = value.trim().toLowerCase() === CONFIRM_PHRASE;

  async function confirmDelete() {
    if (!armed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: value.trim() }),
      });
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as { error?: string } | null;
        // The route only returns a non-2xx when the transaction rolled back, so
        // the account really is still there and a retry is a sensible thing to
        // offer. Stay in the dialog and say so.
        setError(json?.error ?? "Couldn't delete the account. Nothing was removed.");
        setBusy(false);
        return;
      }

      // A hard navigation, not a router push: every route resolves identity
      // server-side, and the identity this page was built against no longer
      // exists. Anything short of a full load leaves stale server-rendered
      // state on screen for an account that is gone.
      window.location.href = "/";
    } catch (err) {
      console.error("[account] delete request failed:", err);
      setError("Couldn't reach the server. Nothing was deleted.");
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-account-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
    >
      {/* Click-away, disabled while the request is in flight. */}
      <button
        type="button"
        aria-label="Cancel"
        tabIndex={-1}
        disabled={busy}
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />

      <div className="relative w-full max-w-sm rounded-2xl border border-bone/10 bg-[#16161c] p-5 font-body text-bone shadow-2xl">
        <h2 id="delete-account-title" className="font-hunt text-base font-bold">
          Delete everything?
        </h2>

        <p className="mt-3 text-sm text-bone/70">
          This removes your profile and resume, every conversation, every search and its results, your
          drafts, and your application tracker. It can&apos;t be undone.
        </p>
        <p className="mt-2 text-sm text-bone/50">
          The shared job listings stay — they aren&apos;t yours and other people are matching against
          them. You&apos;ll be signed out and start fresh.
        </p>

        <label htmlFor="delete-confirm" className="mt-4 block text-xs text-bone/50">
          Type <span className="font-mono text-bone/80">{CONFIRM_PHRASE}</span> to confirm
        </label>
        <input
          id="delete-confirm"
          ref={inputRef}
          value={value}
          disabled={busy}
          autoComplete="off"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") confirmDelete();
          }}
          className="mt-1.5 w-full rounded-xl border border-bone/10 bg-[#0b0b10] px-3 py-2 text-sm text-bone outline-none focus:border-bone/30 disabled:opacity-50"
        />

        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-xl px-3 py-2 text-sm text-bone/70 hover:bg-bone/10 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirmDelete}
            // Disabled until the phrase matches exactly, so the destructive
            // button is never one tab-and-enter away from a focused dialog.
            disabled={!armed || busy}
            className="rounded-xl bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Deleting…" : "Delete everything"}
          </button>
        </div>
      </div>
    </div>
  );
}
