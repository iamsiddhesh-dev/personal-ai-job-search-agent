"use client";

import { useState } from "react";
import type { RankedMatch } from "./types";

interface OutreachDrafts {
  email: { subject: string; body: string };
  linkedin: { body: string };
}

export default function JobCard({ job }: { job: RankedMatch }) {
  const [applied, setApplied] = useState(false);
  const [marking, setMarking] = useState(false);

  const [drafts, setDrafts] = useState<OutreachDrafts | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [draftOpen, setDraftOpen] = useState(false);

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

  async function loadDrafts(regenerate = false) {
    if (!job.matchId) return;
    setDrafting(true);
    setDraftError(null);
    setDraftOpen(true);
    try {
      const res = await fetch("/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchId: job.matchId, regenerate }),
      });
      const json = await res.json();
      if (!res.ok) {
        setDraftError(json.error ?? "Couldn't generate drafts.");
        return;
      }
      setDrafts(json.drafts as OutreachDrafts);
    } catch (err) {
      setDraftError((err as Error).message);
    } finally {
      setDrafting(false);
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
        <span className="font-medium text-zinc-200">
          {job.leadProofType === "experience" ? "Lead with (experience):" : "Lead with (project):"}
        </span>{" "}
        {job.leadProof}
      </div>
      {job.standoutProject && (
        <div className="mt-1 text-[13px] leading-snug">
          <span className="font-medium text-zinc-200">Also worth mentioning:</span> {job.standoutProject}
        </div>
      )}
      <div className="mt-1 text-[13px] leading-snug text-zinc-300">{job.rationale}</div>
      {job.gaps.length > 0 && (
        <div className="mt-1 text-[12px] leading-snug text-amber-400">Gaps: {job.gaps.join("; ")}</div>
      )}

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {job.applyUrl && (
          <a
            href={job.applyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block rounded-full bg-[var(--chat-accent,#0b84ff)] px-3.5 py-1.5 text-[13px] font-semibold text-white"
          >
            Apply →
          </a>
        )}
        <button
          type="button"
          onClick={markApplied}
          disabled={applied || marking}
          className="inline-block rounded-full bg-[var(--chat-field-bg,#3f3f46)] px-3.5 py-1.5 text-[13px] font-semibold text-zinc-100 disabled:opacity-60"
        >
          {applied ? "Applied ✓" : marking ? "Marking…" : "Mark applied"}
        </button>
        {job.matchId && (
          <button
            type="button"
            onClick={() => (draftOpen ? setDraftOpen(false) : loadDrafts(false))}
            disabled={drafting}
            className="inline-block rounded-full bg-[var(--chat-field-bg,#3f3f46)] px-3.5 py-1.5 text-[13px] font-semibold text-zinc-100 disabled:opacity-60"
          >
            {drafting ? "Writing…" : draftOpen ? "Hide drafts" : "Draft outreach"}
          </button>
        )}
      </div>

      {draftOpen && (
        <div className="mt-3 space-y-3 border-t border-zinc-700 pt-3">
          {draftError && <div className="text-[12px] text-red-400">{draftError}</div>}
          {drafts && (
            <>
              <DraftBlock
                label="Cold email"
                subject={drafts.email.subject}
                body={drafts.email.body}
              />
              <DraftBlock label="LinkedIn DM" body={drafts.linkedin.body} charLimit={300} />
              <button
                type="button"
                onClick={() => loadDrafts(true)}
                disabled={drafting}
                className="text-[12px] font-medium text-zinc-400 underline disabled:opacity-60"
              >
                Regenerate
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function DraftBlock({
  label,
  subject,
  body,
  charLimit,
}: {
  label: string;
  subject?: string;
  body: string;
  charLimit?: number;
}) {
  const [copied, setCopied] = useState(false);
  const fullText = subject ? `Subject: ${subject}\n\n${body}` : body;

  async function copy() {
    try {
      await navigator.clipboard.writeText(fullText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked — the text is still selectable in the panel
    }
  }

  return (
    <div className="rounded-xl bg-zinc-900/70 p-2.5">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[12px] font-semibold text-zinc-300">{label}</span>
        <button type="button" onClick={copy} className="text-[12px] font-medium text-[var(--chat-accent,#0b84ff)]">
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
      {subject && (
        <div className="mb-1 text-[12.5px] font-medium text-zinc-200">
          Subject: {subject}
        </div>
      )}
      <div className="whitespace-pre-wrap text-[12.5px] leading-snug text-zinc-300">{body}</div>
      {charLimit && (
        <div className={`mt-1 text-[11px] ${body.length > charLimit ? "text-red-400" : "text-zinc-500"}`}>
          {body.length}/{charLimit} chars
        </div>
      )}
    </div>
  );
}
