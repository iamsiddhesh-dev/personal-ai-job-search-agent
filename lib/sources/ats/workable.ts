import { fetchJson } from "../http";
import type { NormalizedJob } from "../types";

// Workable's public widget API. jobs live under { jobs: [...] }.

interface WorkableJob {
  id?: string | number;
  shortcode?: string;
  title?: string;
  description?: string;
  location?: { city?: string; region?: string; country?: string };
  remote?: boolean;
  type?: string;
  url?: string;
  application_url?: string;
  published_on?: string;
  created_at?: string;
}

function url(slug: string): string {
  return `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(
    slug,
  )}?details=true`;
}

function locationText(loc?: WorkableJob["location"]): string | null {
  if (!loc) return null;
  const parts = [loc.city, loc.region, loc.country].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

export async function fetchJobs(slug: string): Promise<NormalizedJob[] | null> {
  const data = await fetchJson(url(slug));
  const jobs = (data as { jobs?: WorkableJob[] } | null)?.jobs;
  if (!Array.isArray(jobs)) return null;

  return jobs.map((j) => {
    const loc = locationText(j.location);
    return {
      source: "workable",
      externalId: `workable:${slug}:${j.shortcode ?? j.id ?? j.title}`,
      title: j.title ?? "",
      description: j.description ?? null,
      location: loc,
      isRemote: j.remote ?? /remote/i.test(loc ?? ""),
      employmentType: j.type ?? null,
      salaryMin: null,
      salaryMax: null,
      applyUrl: j.url ?? j.application_url ?? null,
      postedAt: j.published_on
        ? new Date(j.published_on)
        : j.created_at
          ? new Date(j.created_at)
          : null,
      raw: j,
    } satisfies NormalizedJob;
  });
}
