import { fetchJson } from "../http";
import type { NormalizedJob } from "../types";

// Ashby dominates early-stage YC (probe: 14 of 17 hits). No pagination.
// Returns null when no board exists at this slug; [] when the board exists but
// has no open roles — the caller must not conflate the two.

interface AshbyJob {
  id?: string;
  title?: string;
  location?: string;
  isRemote?: boolean;
  employmentType?: string;
  publishedAt?: string;
  jobUrl?: string;
  applyUrl?: string;
  descriptionPlain?: string;
  compensation?: {
    compensationTierSummary?: string;
    summaryComponents?: Array<{
      compensationType?: string;
      minValue?: number;
      maxValue?: number;
    }>;
  };
}

function url(slug: string): string {
  return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(
    slug,
  )}?includeCompensation=true`;
}

function salary(job: AshbyJob): [number | null, number | null] {
  const parts = job.compensation?.summaryComponents ?? [];
  const salaryPart = parts.find(
    (p) => (p.compensationType ?? "").toLowerCase() === "salary",
  );
  return [salaryPart?.minValue ?? null, salaryPart?.maxValue ?? null];
}

export async function fetchJobs(slug: string): Promise<NormalizedJob[] | null> {
  const data = await fetchJson(url(slug));
  const jobs = (data as { jobs?: AshbyJob[] } | null)?.jobs;
  if (!Array.isArray(jobs)) return null;

  return jobs.map((j) => {
    const [min, max] = salary(j);
    return {
      source: "ashby",
      externalId: `ashby:${slug}:${j.id ?? j.jobUrl ?? j.title}`,
      title: j.title ?? "",
      description: j.descriptionPlain ?? null,
      location: j.location ?? null,
      isRemote: j.isRemote ?? false,
      employmentType: j.employmentType ?? null,
      salaryMin: min,
      salaryMax: max,
      applyUrl: j.applyUrl ?? j.jobUrl ?? null,
      postedAt: j.publishedAt ? new Date(j.publishedAt) : null,
      raw: j,
    } satisfies NormalizedJob;
  });
}
