import { fetchText } from "./http";
import { fetchJobs } from "./ats";
import type { AtsResolution, AtsType, SourceCompany } from "./types";

// Ported from scripts/probe2.mjs (the validated scanner). Order matters: scan
// the company's own careers page FIRST, fall back to slug-guessing. Probe v1's
// bug was skipping the page scan; fixing it took detection 5.3% -> 21.8%.

// Match an ATS board URL out of page HTML. Greenhouse has migrated to
// job-boards.greenhouse.io alongside old boards.greenhouse.io; both plus .eu
// variants must match.
const PATTERNS: Array<[RegExp, AtsType]> = [
  [
    /(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-zA-Z0-9_-]+)/i,
    "greenhouse",
  ],
  [/greenhouse\.io\/embed\/job_board\?for=([a-zA-Z0-9_-]+)/i, "greenhouse"],
  [/jobs(?:\.eu)?\.lever\.co\/([a-zA-Z0-9_-]+)/i, "lever"],
  [/jobs\.ashbyhq\.com\/([a-zA-Z0-9_.-]+)/i, "ashby"],
  [/ashbyhq\.com\/posting-api\/job-board\/([a-zA-Z0-9_.-]+)/i, "ashby"],
  [/apply\.workable\.com\/([a-zA-Z0-9_-]+)/i, "workable"],
  [/([a-zA-Z0-9_-]+)\.recruitee\.com/i, "recruitee"],
];

// Slugs that appear in board URLs but are never a real company slug.
const RESERVED = new Set([
  "embed",
  "job_board",
  "www",
  "api",
  "jobs",
  "careers",
  "posting-api",
]);

const CAREERS_RE =
  /career|job|hiring|join.?us|work.?with.?us|we.?re.?hiring|open.?roles/i;

function matchPatterns(
  html: string,
): { type: AtsType; slug: string } | null {
  for (const [re, type] of PATTERNS) {
    const m = html.match(re);
    if (m?.[1] && !RESERVED.has(m[1].toLowerCase())) {
      return { type, slug: m[1] };
    }
  }
  return null;
}

// Pull careers-ish links out of homepage HTML instead of guessing fixed paths.
function careersLinks(html: string, origin: string): string[] {
  const out = new Set<string>();
  const re = /href\s*=\s*["']([^"']+)["'][^>]*>([^<]{0,80})</gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = m[1];
    const text = (m[2] || "").toLowerCase();
    if (CAREERS_RE.test(href + " " + text)) {
      try {
        out.add(new URL(href, origin).href);
      } catch {
        // ignore malformed hrefs
      }
    }
    if (out.size > 8) break;
  }
  return [...out];
}

async function scanCareers(
  website: string | null,
): Promise<AtsResolution | null> {
  if (!website) return null;
  let origin: string;
  try {
    origin = new URL(website).origin;
  } catch {
    return null;
  }

  const home = await fetchText(origin);
  if (home) {
    const direct = matchPatterns(home);
    if (direct) return { ...direct, via: "page:home" };
  }

  const candidates = new Set<string>([
    ...(home ? careersLinks(home, origin) : []),
    `${origin}/careers`,
    `${origin}/jobs`,
    `${origin}/company/careers`,
    origin.replace("://", "://careers."),
  ]);

  for (const url of [...candidates].slice(0, 6)) {
    const html = await fetchText(url);
    if (!html) continue;
    const hit = matchPatterns(html);
    if (hit) return { ...hit, via: "page:link" };
  }
  return null;
}

// Slug guesses derived from the company's name / website root / YC slug.
function slugCandidates(c: SourceCompany): string[] {
  const set = new Set<string>();
  if (c.slug) set.add(c.slug);
  if (c.name) {
    const n = c.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (n) set.add(n);
  }
  if (c.website) {
    try {
      const root = new URL(c.website).hostname
        .replace(/^www\./, "")
        .split(".")[0];
      if (root) set.add(root);
    } catch {
      // ignore
    }
  }
  return [...set].filter(Boolean).slice(0, 3);
}

// Resolve which ATS (if any) a company uses. Careers-page scan is trusted even
// when the board is empty (existence is the signal). Slug-guessing requires at
// least one open job to avoid false positives on unrelated boards.
export async function resolveAts(
  c: SourceCompany,
): Promise<AtsResolution | null> {
  const scanned = await scanCareers(c.website);
  if (scanned) {
    const jobs = await fetchJobs(scanned.type, scanned.slug);
    if (jobs !== null) return scanned;
  }

  const guessTypes: AtsType[] = ["ashby", "greenhouse", "lever"];
  for (const slug of slugCandidates(c)) {
    for (const type of guessTypes) {
      const jobs = await fetchJobs(type, slug);
      if (jobs !== null && jobs.length > 0) {
        return { type, slug, via: "guess" };
      }
    }
  }
  return null;
}
