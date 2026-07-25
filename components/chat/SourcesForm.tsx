"use client";

import { useState } from "react";

export interface SourcesSubmission {
  resumeFile: File | null;
  githubUsername: string;
  linkedinUrl: string;
  portfolioUrl: string;
}

export default function SourcesForm({
  onSubmit,
  disabled,
}: {
  onSubmit: (data: SourcesSubmission) => void;
  disabled: boolean;
}) {
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [githubUsername, setGithubUsername] = useState("");
  const [linkedinUrl, setLinkedinUrl] = useState("");
  const [portfolioUrl, setPortfolioUrl] = useState("");

  const hasAny = !!resumeFile || !!githubUsername.trim() || !!linkedinUrl.trim() || !!portfolioUrl.trim();

  return (
    <div className="mx-3 mb-2 rounded-[18px] rounded-bl-[4px] bg-zinc-700 p-3.5 text-white">
      <label className="flex items-center justify-between gap-2 rounded-lg bg-zinc-600/60 px-3 py-2 text-[14px]">
        <span className="truncate">{resumeFile ? resumeFile.name : "+ Upload resume (PDF/DOCX/TXT)"}</span>
        <input
          type="file"
          accept=".pdf,.docx,.txt,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
          className="hidden"
          onChange={(e) => setResumeFile(e.target.files?.[0] ?? null)}
        />
      </label>

      <input
        value={githubUsername}
        onChange={(e) => setGithubUsername(e.target.value)}
        placeholder="GitHub username or URL"
        className="mt-2 w-full rounded-lg bg-zinc-600/60 px-3 py-2 text-[14px] placeholder:text-zinc-400 focus:outline-none"
      />
      <input
        value={linkedinUrl}
        onChange={(e) => setLinkedinUrl(e.target.value)}
        placeholder="LinkedIn profile URL (optional)"
        className="mt-2 w-full rounded-lg bg-zinc-600/60 px-3 py-2 text-[14px] placeholder:text-zinc-400 focus:outline-none"
      />
      <input
        value={portfolioUrl}
        onChange={(e) => setPortfolioUrl(e.target.value)}
        placeholder="Portfolio URL (optional)"
        className="mt-2 w-full rounded-lg bg-zinc-600/60 px-3 py-2 text-[14px] placeholder:text-zinc-400 focus:outline-none"
      />

      <button
        disabled={!hasAny || disabled}
        onClick={() => onSubmit({ resumeFile, githubUsername, linkedinUrl, portfolioUrl })}
        className="mt-3 w-full rounded-full bg-[#0b84ff] py-2 text-[14px] font-semibold text-white disabled:opacity-40"
      >
        That&apos;s what I have →
      </button>
    </div>
  );
}
