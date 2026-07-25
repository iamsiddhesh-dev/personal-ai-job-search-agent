"use client";

import { useEffect, useState } from "react";

interface DueApplication {
  id: string;
  title: string;
  company: string;
  status: string;
  nextFollowupAt: string | null;
}

// Surfaces applications whose follow-up date has arrived (REVISED-PLAN §8
// Phase 5 exit test: "resurfaces on its follow-up date"). Fetched once when
// the chat panel opens — this is a solo tracker, not a live subscription.
export default function FollowupsBanner() {
  const [due, setDue] = useState<DueApplication[] | null>(null);
  const [bumping, setBumping] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/applications?due=true")
      .then((res) => res.json())
      .then((json) => setDue(json.applications ?? []))
      .catch(() => setDue([]));
  }, []);

  async function bumpSent(id: string) {
    setBumping(id);
    try {
      await fetch("/api/applications", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      setDue((prev) => (prev ? prev.filter((a) => a.id !== id) : prev));
    } finally {
      setBumping(null);
    }
  }

  if (!due || due.length === 0) return null;

  return (
    <div className="mx-3 mb-2 rounded-xl bg-amber-500/10 p-2.5 text-[12.5px] text-amber-200">
      <div className="mb-1 font-semibold">Follow up today:</div>
      <ul className="space-y-1">
        {due.map((a) => (
          <li key={a.id} className="flex items-center justify-between gap-2">
            <span>
              {a.title} @ {a.company} — {statusLabel(a.status)}
            </span>
            <button
              type="button"
              onClick={() => bumpSent(a.id)}
              disabled={bumping === a.id}
              className="shrink-0 rounded-full bg-amber-500/20 px-2 py-0.5 text-[11px] font-semibold text-amber-100 disabled:opacity-60"
            >
              {bumping === a.id ? "…" : "Sent"}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function statusLabel(status: string): string {
  switch (status) {
    case "applied":
      return "send bump #1";
    case "followed_up_1":
      return "send bump #2";
    case "followed_up_2":
      return "final check-in";
    default:
      return status;
  }
}
