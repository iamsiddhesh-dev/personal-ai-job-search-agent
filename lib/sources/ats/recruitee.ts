import { fetchJson } from "../http";
import type { NormalizedJob } from "../types";

// Recruitee serves per-subdomain: {slug}.recruitee.com. A wrong slug is a DNS
// failure (ENOTFOUND), not a 404 — fetchJson already swallows that as null, so
// a null body here means "no board" the same way a 404 would.

interface RecruiteeOffer {
  id?: number | string;
  title?: string;
  description?: string;
  location?: string;
  city?: string;
  country_code?: string;
  remote?: boolean;
  employment_type_code?: string;
  careers_url?: string;
  careers_apply_url?: string;
  published_at?: string;
  created_at?: string;
  min_hours?: number;
}

function url(slug: string): string {
  return `https://${encodeURIComponent(slug)}.recruitee.com/api/offers/`;
}

function locationText(o: RecruiteeOffer): string | null {
  if (o.location) return o.location;
  const parts = [o.city, o.country_code].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

export async function fetchJobs(slug: string): Promise<NormalizedJob[] | null> {
  const data = await fetchJson(url(slug));
  const offers = (data as { offers?: RecruiteeOffer[] } | null)?.offers;
  if (!Array.isArray(offers)) return null;

  return offers.map((o) => {
    const loc = locationText(o);
    return {
      source: "recruitee",
      externalId: `recruitee:${slug}:${o.id ?? o.careers_url ?? o.title}`,
      title: o.title ?? "",
      description: o.description ?? null,
      location: loc,
      isRemote: o.remote ?? /remote/i.test(loc ?? ""),
      employmentType: o.employment_type_code ?? null,
      salaryMin: null,
      salaryMax: null,
      applyUrl: o.careers_apply_url ?? o.careers_url ?? null,
      postedAt: o.published_at
        ? new Date(o.published_at)
        : o.created_at
          ? new Date(o.created_at)
          : null,
      raw: o,
    } satisfies NormalizedJob;
  });
}
