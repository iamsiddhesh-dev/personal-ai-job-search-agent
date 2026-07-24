export type AtsType =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "workable"
  | "recruitee";

export type JobSource = AtsType | "himalayas";

// One job, normalized across every source, shaped to map cleanly onto the
// `jobs` table (see db/schema.ts). `externalId` must be stable across runs so
// UNIQUE(source, external_id) makes re-ingestion idempotent.
export interface NormalizedJob {
  source: JobSource;
  externalId: string;
  title: string;
  description: string | null;
  location: string | null;
  isRemote: boolean;
  employmentType: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  applyUrl: string | null;
  postedAt: Date | null;
  raw: unknown;
}

// A company as we care about it for harvesting. Companies come from YC's API or
// from curated accelerator lists.
export interface SourceCompany {
  name: string;
  slug: string | null;
  website: string | null;
  source: "yc" | "curated" | "speedrun";
  ycBatch: string | null;
  teamSize: number | null;
  industries: string[];
  regions: string[];
}

export interface AtsResolution {
  type: AtsType;
  slug: string;
  via: "page:home" | "page:link" | "guess";
}
