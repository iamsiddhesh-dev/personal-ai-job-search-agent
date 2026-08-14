"use client";

// Confirmation for "New chat".
//
// The thread is only ARCHIVED, not destroyed — it stays in Postgres for 30 days
// before the sweep takes it (scripts/sweep-conversations.ts). But nothing in the
// UI can reopen an archived thread, so from the user's side one click makes
// their conversation disappear with no undo. That is worse than being honestly
// permanent or honestly recoverable, so it gets a stop.
//
// Deliberately NOT the typed-phrase gate DeleteAccountDialog uses. That one
// guards something genuinely irreversible; reusing it here would teach people
// to type the phrase without reading it, which is exactly what would make the
// real one stop working. A plain Cancel/confirm pair is the right weight.
//
// The copy leads with what SURVIVES, because "new chat" sounds like it might
// take the profile with it — and the one thing SCALE-PLAN is firm about is that
// reset is chat only: the agent must still know who they are afterwards and
// must not re-ask for the resume.
//
// It also does not mention the 30 days. That window is real, but there is no
// way for a user to act on it — telling them their chat is "kept" while giving
// them no way to open it is a promise the UI cannot keep. When archived threads
// become reachable (SCALE-PLAN Phase C, still open), this copy changes with it.

import { useEffect, useRef, useState } from "react";

export function NewChatDialog({
  onConfirm,
  onClose,
}: {
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // Focus lands on Cancel, not on the confirm button. Moving focus into the
  // dialog is what a dialog owes a keyboard user, but this one exists to catch
  // an accidental action — so a stray Enter must not be the thing that
  // completes it.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      // The old thread is still on screen and still theirs — nothing happened,
      // so say so plainly and let them try again.
      console.error("[account] could not start a new chat:", err);
      setError("Couldn't start a new chat. Your current one is untouched.");
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-chat-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
    >
      <button
        type="button"
        aria-label="Cancel"
        tabIndex={-1}
        disabled={busy}
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />

      <div className="relative w-full max-w-sm rounded-2xl border border-bone/10 bg-[#16161c] p-5 font-body text-bone shadow-2xl">
        <h2 id="new-chat-title" className="font-hunt text-base font-bold">
          Start a new chat?
        </h2>

        <p className="mt-3 text-sm text-bone/70">
          Your profile, resume, saved jobs and applications all stay — the agent will still know who
          you are and won&apos;t ask for your resume again.
        </p>
        <p className="mt-2 text-sm text-bone/50">
          This conversation drops off the screen, and you won&apos;t be able to open it again from
          here.
        </p>

        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-xl px-3 py-2 text-sm text-bone/70 hover:bg-bone/10 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            disabled={busy}
            className="rounded-xl bg-bone px-3 py-2 text-sm font-semibold text-ink hover:bg-bone/90 disabled:opacity-40"
          >
            {busy ? "Starting…" : "Start new chat"}
          </button>
        </div>
      </div>
    </div>
  );
}
