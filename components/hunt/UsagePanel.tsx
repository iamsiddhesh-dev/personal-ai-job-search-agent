"use client";

// "Your usage" — what's left of today's allowance, your own API key, and your
// past chats (SCALE-PLAN Phase D).
//
// Three things share one panel because they are one question: how much of this
// can I use, and what have I already done with it. The quota bars explain why
// the agent might refuse; the key field is how you remove the limit; the thread
// list is the archive that has existed since Phase C with nothing able to open
// it.
//
// That last part is the fix for a real gap. "New chat" archives rather than
// deletes, but no surface listed archived threads, so a reversible action
// looked permanent — which is the entire reason NewChatDialog had to warn that
// the conversation could not be reopened. It can now.

import { useCallback, useEffect, useRef, useState } from "react";
import { KeyRound, Loader2, MessageSquare, RotateCcw, Trash2, X } from "lucide-react";

interface Quota {
  allowed: boolean;
  used: number;
  limit: number;
  exempt: boolean;
}

interface KeySummary {
  provider: string;
  last4: string;
  createdAt: string;
  lastUsedAt: string | null;
}

interface Thread {
  id: string;
  title: string | null;
  updatedAt: string;
  archivedAt?: string;
}

interface UsageData {
  signedIn: boolean;
  byokAvailable: boolean;
  usage: { chat_turn: Quota; search: Quota };
  keys: KeySummary[];
  threads: { live: Thread[]; archived: Thread[] };
}

const relative = (iso: string): string => {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
};

function QuotaBar({ label, quota }: { label: string; quota: Quota }) {
  if (quota.exempt) {
    return (
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-bone/70">{label}</span>
        <span className="text-emerald-400">unlimited — your own key</span>
      </div>
    );
  }
  const pct = quota.limit > 0 ? Math.min(100, (quota.used / quota.limit) * 100) : 100;
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-bone/70">{label}</span>
        <span className={quota.allowed ? "text-bone/50" : "text-amber-400"}>
          {quota.used} / {quota.limit}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-bone/10">
        <div
          className={`h-full rounded-full ${quota.allowed ? "bg-bone/40" : "bg-amber-400/80"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function UsagePanel({
  onOpenThread,
  onClose,
}: {
  /** Reopen an archived thread in the chat panel. Owned by HuntChatFrame. */
  onOpenThread: (id: string) => void;
  onClose: () => void;
}) {
  const [data, setData] = useState<UsageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/usage", { credentials: "same-origin" });
      if (!res.ok) throw new Error(String(res.status));
      setData((await res.json()) as UsageData);
    } catch (err) {
      console.error("[usage] could not load:", err);
      setError("Couldn't load your usage just now.");
    }
  }, []);

  // The first load is written out here rather than calling load(), with the
  // same cancelled-guard shape AccountMenu uses: a state update from a fetch
  // that resolves after the panel has closed is a no-op at best and a warning
  // at worst. load() itself is for the refreshes that follow a mutation, which
  // run from event handlers where there is nothing to guard against.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/usage", { credentials: "same-origin" })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((body: UsageData) => {
        if (!cancelled) setData(body);
      })
      .catch((err) => {
        console.error("[usage] could not load:", err);
        if (!cancelled) setError("Couldn't load your usage just now.");
      });
    closeRef.current?.focus();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const saveKey = useCallback(async () => {
    const apiKey = keyInput.trim();
    if (!apiKey) return;
    setBusy("key");
    setError(null);
    try {
      const res = await fetch("/api/keys", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "groq", apiKey }),
      });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "could not save that key");
      // Cleared immediately on success — the field should never keep holding a
      // credential once it has been stored.
      setKeyInput("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save that key.");
    } finally {
      setBusy(null);
    }
  }, [keyInput, load]);

  const removeKey = useCallback(
    async (provider: string) => {
      setBusy(`del-${provider}`);
      setError(null);
      try {
        await fetch("/api/keys", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider }),
        });
        await load();
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const reopen = useCallback(
    async (id: string) => {
      setBusy(`open-${id}`);
      setError(null);
      try {
        const res = await fetch(`/api/conversations/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ archived: false }),
        });
        if (!res.ok) throw new Error(String(res.status));
        onOpenThread(id);
        onClose();
      } catch (err) {
        console.error("[usage] could not reopen thread:", err);
        setError("Couldn't reopen that chat.");
        setBusy(null);
      }
    },
    [onOpenThread, onClose],
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="usage-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
    >
      <button
        type="button"
        aria-label="Close"
        tabIndex={-1}
        className="absolute inset-0 cursor-default"
        onClick={onClose}
      />

      <div className="relative flex max-h-[85dvh] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-bone/10 bg-[#16161c] font-body text-bone shadow-2xl">
        <div className="flex items-center justify-between border-b border-bone/10 px-5 py-3">
          {/* Matches the menu entry and the sentence in NewChatDialog word for
              word. That dialog tells people where their conversation went, and
              a pointer that does not match the thing it points at is worse than
              no pointer. */}
          <h2 id="usage-title" className="font-hunt text-base font-bold">
            Usage &amp; past chats
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-7 w-7 items-center justify-center rounded-full text-bone/60 hover:bg-bone/10"
          >
            <X size={15} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {!data && !error && (
            <div className="flex items-center gap-2 py-6 text-sm text-bone/50">
              <Loader2 size={14} className="animate-spin" /> loading…
            </div>
          )}
          {error && <p className="text-sm text-red-400">{error}</p>}

          {data && (
            <>
              <section className="space-y-3">
                <QuotaBar label="Chats today" quota={data.usage.chat_turn} />
                <QuotaBar label="Searches today" quota={data.usage.search} />
                <p className="text-xs text-bone/40">
                  Resets at midnight UTC.
                  {!data.signedIn && " Signing in raises both."}
                </p>
              </section>

              <section className="border-t border-bone/10 pt-4">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-bone/80">
                  <KeyRound size={14} /> Your own Groq key
                </h3>

                {!data.byokAvailable ? (
                  <p className="mt-2 text-xs text-bone/40">
                    Not available on this deployment yet.
                  </p>
                ) : !data.signedIn ? (
                  <p className="mt-2 text-xs text-bone/40">
                    Sign in first — a key is stored against your account.
                  </p>
                ) : data.keys.length > 0 ? (
                  <div className="mt-2 space-y-2">
                    {data.keys.map((k) => (
                      <div
                        key={k.provider}
                        className="flex items-center justify-between rounded-xl bg-bone/5 px-3 py-2"
                      >
                        <span className="text-sm">
                          <span className="text-bone/50">{k.provider}</span>{" "}
                          <span className="font-mono">{k.last4}</span>
                          <span className="ml-2 text-xs text-bone/40">
                            {k.lastUsedAt ? `used ${relative(k.lastUsedAt)}` : "not used yet"}
                          </span>
                        </span>
                        <button
                          type="button"
                          onClick={() => removeKey(k.provider)}
                          disabled={busy !== null}
                          aria-label={`Remove ${k.provider} key`}
                          className="text-bone/40 hover:text-red-400 disabled:opacity-40"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="mt-2">
                    <p className="text-xs text-bone/50">
                      Free at console.groq.com, no card, about a minute. With one, none of the
                      limits above apply to you.
                    </p>
                    <div className="mt-2 flex gap-2">
                      <input
                        type="password"
                        value={keyInput}
                        onChange={(e) => setKeyInput(e.target.value)}
                        placeholder="gsk_…"
                        autoComplete="off"
                        spellCheck={false}
                        className="min-w-0 flex-1 rounded-xl bg-[#121218] px-3 py-2 font-mono text-sm text-bone placeholder:text-bone/30 focus:outline-none focus:ring-1 focus:ring-bone/30"
                      />
                      <button
                        type="button"
                        onClick={saveKey}
                        disabled={busy !== null || !keyInput.trim()}
                        className="rounded-xl bg-bone px-3 py-2 text-sm font-semibold text-ink hover:bg-bone/90 disabled:opacity-40"
                      >
                        {busy === "key" ? "Saving…" : "Save"}
                      </button>
                    </div>
                  </div>
                )}
              </section>

              <section className="border-t border-bone/10 pt-4">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-bone/80">
                  <MessageSquare size={14} /> Past chats
                </h3>

                {data.threads.archived.length === 0 ? (
                  <p className="mt-2 text-xs text-bone/40">
                    Nothing archived yet. Threads land here when you start a new chat, and are
                    deleted 30 days later.
                  </p>
                ) : (
                  <ul className="mt-2 space-y-1">
                    {data.threads.archived.map((t) => (
                      <li key={t.id}>
                        <button
                          type="button"
                          onClick={() => reopen(t.id)}
                          disabled={busy !== null}
                          className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left hover:bg-bone/5 disabled:opacity-40"
                        >
                          <RotateCcw size={13} className="shrink-0 text-bone/40" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm">
                              {t.title ?? "untitled chat"}
                            </span>
                            <span className="block text-xs text-bone/40">
                              archived {relative(t.archivedAt!)}
                            </span>
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
