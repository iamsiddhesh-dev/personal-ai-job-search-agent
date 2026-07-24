import { fetchJson, mapLimit } from "./http";
import type { SourceCompany } from "./types";

// YC's public company API. ~244 pages x 25 ≈ 6,100 companies. IMPORTANT: the
// API is newest-batch-first, but batches interleave across pages (P/F/S/W) —
// never assume page number maps to batch age. Fetch broadly, filter on `batch`.

interface YcCompany {
  name?: string;
  slug?: string;
  website?: string;
  batch?: string;
  teamSize?: number;
  industries?: string[];
  regions?: string[];
  status?: string;
  oneLiner?: string;
  longDescription?: string;
}

interface YcPage {
  companies?: YcCompany[];
}

function pageUrl(page: number): string {
  return `https://api.ycombinator.com/v0.1/companies?page=${page}`;
}

function toSourceCompany(c: YcCompany): SourceCompany {
  return {
    name: c.name ?? "",
    slug: c.slug ?? null,
    website: c.website ?? null,
    source: "yc",
    ycBatch: c.batch ?? null,
    teamSize: typeof c.teamSize === "number" ? c.teamSize : null,
    industries: Array.isArray(c.industries) ? c.industries : [],
    regions: Array.isArray(c.regions) ? c.regions : [],
  };
}

// A transient network blip can make an entire concurrent batch of pages come
// back null even mid-list — that happened on a real run (stopped at page ~73
// of ~244). Retry each page a couple of times before treating it as empty, and
// require two consecutive fully-empty *batches* (not just one) before
// concluding we've reached the end of the list.
async function fetchPage(page: number, attempts = 3): Promise<YcCompany[]> {
  for (let i = 0; i < attempts; i++) {
    const data = (await fetchJson(pageUrl(page))) as YcPage | null;
    if (data?.companies) return data.companies;
  }
  return [];
}

// Fetch every YC company. Pages are fetched in concurrent batches; maxPages is
// a safety cap well above the real page count (~244 as of writing).
export async function fetchYcCompanies(
  { concurrency = 8, batchSize = 24, maxPages = 300 } = {},
): Promise<SourceCompany[]> {
  const all: SourceCompany[] = [];
  let start = 1;
  let consecutiveEmptyBatches = 0;

  while (start <= maxPages) {
    const pages = Array.from(
      { length: Math.min(batchSize, maxPages - start + 1) },
      (_, i) => start + i,
    );
    const results = await mapLimit(pages, concurrency, (p) => fetchPage(p));

    const batchCompanies = results.flat();
    if (batchCompanies.length === 0) {
      consecutiveEmptyBatches++;
      if (consecutiveEmptyBatches >= 2) break;
      start += pages.length;
      continue;
    }
    consecutiveEmptyBatches = 0;

    for (const c of batchCompanies) {
      if (c.name) all.push(toSourceCompany(c));
    }
    start += pages.length;
  }

  return all;
}
