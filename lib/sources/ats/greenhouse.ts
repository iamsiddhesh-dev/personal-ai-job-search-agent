import { fetchJson } from "../http";
import type { NormalizedJob } from "../types";

// Greenhouse lives on both boards-api.greenhouse.io (old) and job-boards
// (new); the board slug is the same on either. The v1 boards API serves both.
// content=true returns the (HTML) description.

interface GreenhouseJob {
  id?: number | string;
  title?: string;
  location?: { name?: string };
  absolute_url?: string;
  updated_at?: string;
  content?: string;
}

function url(slug: string): string {
  return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(
    slug,
  )}/jobs?content=true`;
}

function stripHtml(html?: string): string | null {
  if (!html) return null;
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

export async function fetchJobs(slug: string): Promise<NormalizedJob[] | null> {
  const data = await fetchJson(url(slug));
  const jobs = (data as { jobs?: GreenhouseJob[] } | null)?.jobs;
  if (!Array.isArray(jobs)) return null;

  return jobs.map((j) => {
    const loc = j.location?.name ?? null;
    return {
      source: "greenhouse",
      externalId: `greenhouse:${slug}:${j.id ?? j.absolute_url ?? j.title}`,
      title: j.title ?? "",
      description: stripHtml(j.content),
      location: loc,
      isRemote: /remote/i.test(loc ?? ""),
      employmentType: null,
      salaryMin: null,
      salaryMax: null,
      applyUrl: j.absolute_url ?? null,
      postedAt: j.updated_at ? new Date(j.updated_at) : null,
      raw: j,
    } satisfies NormalizedJob;
  });
}
