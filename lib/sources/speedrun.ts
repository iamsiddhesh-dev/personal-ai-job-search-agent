import { fetchJson, mapLimit } from "./http";
import type { SourceCompany } from "./types";

// a16z Speedrun's public company API — genuinely paginated JSON, no auth,
// discovered via the site's __NEXT_DATA__ payload. Small (~240 companies) but
// well-structured: unlike YC it gives team_size AND website_url directly on
// every record, so no slug-guessing is needed to resolve ATS boards.
//
//   https://speedrun-be.a16z.com/api/companies/companies/?limit=100&offset=N&ordering=name

interface SpeedrunCompany {
  name?: string;
  slug?: string;
  website_url?: string;
  cohort?: string;
  team_size?: number;
  industries?: string[];
  country?: string;
  region?: string;
  city?: string;
}

interface SpeedrunPage {
  count?: number;
  next?: string | null;
  results?: SpeedrunCompany[];
}

function pageUrl(offset: number, limit: number): string {
  return `https://speedrun-be.a16z.com/api/companies/companies/?limit=${limit}&offset=${offset}&ordering=name`;
}

function toSourceCompany(c: SpeedrunCompany): SourceCompany {
  const regions = [c.city, c.country].filter((x): x is string => !!x);
  return {
    name: c.name ?? "",
    slug: c.slug ?? null,
    website: c.website_url || null,
    source: "speedrun",
    ycBatch: c.cohort ?? null, // Speedrun cohort (e.g. "SR003"), reused for provenance
    teamSize: typeof c.team_size === "number" ? c.team_size : null,
    industries: Array.isArray(c.industries) ? c.industries : [],
    regions,
  };
}

export async function fetchSpeedrunCompanies(
  { limit = 100, concurrency = 4 } = {},
): Promise<SourceCompany[]> {
  const first = (await fetchJson(pageUrl(0, limit))) as SpeedrunPage | null;
  const total = first?.count ?? 0;
  const all: SpeedrunCompany[] = [...(first?.results ?? [])];
  if (total === 0) return [];

  const remainingOffsets: number[] = [];
  for (let offset = limit; offset < total; offset += limit) {
    remainingOffsets.push(offset);
  }

  const pages = await mapLimit(remainingOffsets, concurrency, async (offset) => {
    const data = (await fetchJson(pageUrl(offset, limit))) as SpeedrunPage | null;
    return data?.results ?? [];
  });
  for (const page of pages) all.push(...page);

  return all.filter((c) => c.name).map(toSourceCompany);
}
