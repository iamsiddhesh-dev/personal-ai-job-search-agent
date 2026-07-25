"use client";

import { useState } from "react";
import type { RankedMatch } from "./types";

export default function JobCard({ job }: { job: RankedMatch }) {
  const [applied, setApplied] = useState(false);
  const [marking, setMarking] = useState(false);

  async function markApplied() {
    setMarking(true);
    try {
      const res = await fetch("/api/applications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.jobId, companyName: job.company, roleTitle: job.title }),
      });
      if (res.ok) setApplied(true);
    } finally {
      setMarking(false);
    }
  }

  return (
    <div className="rounded-2xl bg-zinc-800/90 p-3.5 text-white shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[15px] font-semibold leading-tight">{job.title}</div>
          <div className="text-[13px] text-zinc-300">{job.company}</div>
        </div>
        <div className="shrink-0 rounded-full bg-emerald-500/20 px-2 py-0.5 text-[12px] font-semibold text-emerald-400">
          {job.score}
        </div>
      </div>

      <div className="mt-1.5 text-[12px] text-zinc-400">
        {job.location ?? "Location n/a"}
        {job.isRemote ? " · remote" : ""}
        {job.teamSize ? ` · team ${job.teamSize}` : ""}
        {job.hiringSignal === "inferred" ? " · inferred opening" : " · verified opening"}
      </div>

      <div className="mt-2 text-[13px] leading-snug">
        <span className="font-medium text-zinc-200">Lead with:</span> {job.leadProject}
      </div>
      <div className="mt-1 text-[13px] leading-snug text-zinc-300">{job.rationale}</div>
      {job.gaps.length > 0 && (
        <div className="mt-1 text-[12px] leading-snug text-amber-400">Gaps: {job.gaps.join("; ")}</div>
      )}

      <div className="mt-2.5 flex items-center gap-2">
        {job.applyUrl && (
          <a
            href={job.applyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block rounded-full bg-[#0b84ff] px-3.5 py-1.5 text-[13px] font-semibold text-white"
          >
            Apply →
          </a>
        )}
        <button
          type="button"
          onClick={markApplied}
          disabled={applied || marking}
          className="inline-block rounded-full bg-zinc-700 px-3.5 py-1.5 text-[13px] font-semibold text-zinc-100 disabled:opacity-60"
        >
          {applied ? "Applied ✓" : marking ? "Marking…" : "Mark applied"}
        </button>
      </div>
    </div>
  );
}
