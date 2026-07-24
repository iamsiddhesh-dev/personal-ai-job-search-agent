import { fetchJson, mapLimit } from "./http";
import type { NormalizedJob, SourceCompany } from "./types";

// Himalayas remote-jobs feed. Max 20 per request. SUPPLEMENT ONLY — probe
// showed it skews to large US companies, with few roles open to India. Each job
// carries its own company, so we emit company+job pairs for the harvester.

export interface HimalayasEntry {
  company: SourceCompany;
  job: NormalizedJob;
}

interface HimalayasJob {
  guid?: string;
  title?: string;
  excerpt?: string;
  description?: string;
  companyName?: string;
  companySlug?: string;
  companyLogo?: string;
  applicationLink?: string;
  pubDate?: number | string;
  minSalary?: number;
  maxSalary?: number;
  seniority?: string[] | string;
  employmentType?: string;
  locationRestrictions?: string[];
  categories?: string[];
}

function url(offset: number): string {
  return `https://himalayas.app/jobs/api?limit=20&offset=${offset}`;
}

function toEntry(j: HimalayasJob): HimalayasEntry | null {
  if (!j.title || !j.companyName) return null;
  const restrictions = Array.isArray(j.locationRestrictions)
    ? j.locationRestrictions
    : [];
  const location = restrictions.length ? restrictions.join(", ") : "Remote";

  const company: SourceCompany = {
    name: j.companyName,
    slug: j.companySlug ?? null,
    website: null,
    source: "curated",
    ycBatch: null,
    teamSize: null,
    industries: Array.isArray(j.categories) ? j.categories : [],
    regions: restrictions,
  };

  const job: NormalizedJob = {
    source: "himalayas",
    externalId: `himalayas:${j.guid ?? j.applicationLink ?? `${j.companySlug}:${j.title}`}`,
    title: j.title,
    description: j.description ?? j.excerpt ?? null,
    location,
    isRemote: true,
    employmentType: j.employmentType ?? null,
    salaryMin: typeof j.minSalary === "number" ? j.minSalary : null,
    salaryMax: typeof j.maxSalary === "number" ? j.maxSalary : null,
    applyUrl: j.applicationLink ?? null,
    postedAt: j.pubDate ? new Date(j.pubDate) : null,
    raw: j,
  };

  return { company, job };
}

export async function fetchHimalayas(pages = 15): Promise<HimalayasEntry[]> {
  const offsets = Array.from({ length: pages }, (_, i) => i * 20);
  const results = await mapLimit(offsets, 6, async (offset) => {
    const data = (await fetchJson(url(offset))) as
      | { jobs?: HimalayasJob[] }
      | null;
    return Array.isArray(data?.jobs) ? data!.jobs : [];
  });

  const entries: HimalayasEntry[] = [];
  for (const j of results.flat()) {
    const e = toEntry(j);
    if (e) entries.push(e);
  }
  return entries;
}
