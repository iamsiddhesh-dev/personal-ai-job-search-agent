import { fetchJson } from "../http";
import type { NormalizedJob } from "../types";

// Lever returns a bare array (no wrapper object). A non-array response means
// no board at this slug.

interface LeverJob {
  id?: string;
  text?: string;
  descriptionPlain?: string;
  hostedUrl?: string;
  applyUrl?: string;
  createdAt?: number;
  categories?: {
    location?: string;
    commitment?: string;
  };
  workplaceType?: string;
  salaryRange?: { min?: number; max?: number };
}

function url(slug: string): string {
  return `https://api.lever.co/v0/postings/${encodeURIComponent(
    slug,
  )}?mode=json`;
}

export async function fetchJobs(slug: string): Promise<NormalizedJob[] | null> {
  const data = await fetchJson(url(slug));
  if (!Array.isArray(data)) return null;
  const jobs = data as LeverJob[];

  return jobs.map((j) => {
    const loc = j.categories?.location ?? null;
    return {
      source: "lever",
      externalId: `lever:${slug}:${j.id ?? j.hostedUrl ?? j.text}`,
      title: j.text ?? "",
      description: j.descriptionPlain ?? null,
      location: loc,
      isRemote:
        (j.workplaceType ?? "").toLowerCase() === "remote" ||
        /remote/i.test(loc ?? ""),
      employmentType: j.categories?.commitment ?? null,
      salaryMin: j.salaryRange?.min ?? null,
      salaryMax: j.salaryRange?.max ?? null,
      applyUrl: j.applyUrl ?? j.hostedUrl ?? null,
      postedAt: j.createdAt ? new Date(j.createdAt) : null,
      raw: j,
    } satisfies NormalizedJob;
  });
}
