// Klipy GIF search — the fallback when the curated pack has nothing for a mood.
//
// Replaced Tenor, which Google shut down on 30 June 2026 (new keys were already
// blocked from January). Klipy was built by ex-Tenor engineers, is free with no
// cap on a production key, and WhatsApp migrated to it — the closest thing to a
// like-for-like successor.
//
// Every failure path returns null rather than throwing: a meme is garnish, and
// a missing key or a rate limit must never take down a chat turn.

const BASE_URL = "https://api.klipy.com/api/v1";
const TIMEOUT_MS = 4000;

// Klipy also serves /clips, /stickers and /memes. GIFs are the documented,
// safe default; switch this once you've confirmed a path against live docs.
const MEDIA_TYPE = "gifs";

// Biases results toward Indian/Hinglish content, matching the agent's voice.
const LOCALE = process.env.KLIPY_LOCALE || "en_IN";

interface KlipyItem {
  // Media lives under `files`, keyed by size then format. The exact nesting is
  // not guaranteed stable, so it's walked defensively rather than indexed.
  files?: Record<string, Record<string, { url?: string }> | undefined>;
  title?: string;
}

interface KlipyResponse {
  result?: boolean;
  data?: { data?: KlipyItem[] };
}

// Prefer a small rendition — these render at 220px in the bubble, so a full-size
// GIF is wasted bytes on a phone.
const SIZE_PREFERENCE = ["sm", "small", "tiny", "md", "medium", "hd", "lg", "original"];
const FORMAT_PREFERENCE = ["gif", "webp", "mp4"];

function firstUrl(item: KlipyItem): string | null {
  const files = item.files;
  if (!files) return null;

  const sizes = [...SIZE_PREFERENCE, ...Object.keys(files)];
  for (const size of sizes) {
    const formats = files[size];
    if (!formats) continue;
    for (const format of [...FORMAT_PREFERENCE, ...Object.keys(formats)]) {
      const url = formats[format]?.url;
      if (typeof url === "string" && url.startsWith("http")) return url;
    }
  }
  return null;
}

export async function searchKlipy(query: string): Promise<string | null> {
  const key = process.env.KLIPY_API_KEY;
  if (!key || !query.trim()) return null;

  // The API key is a PATH segment on Klipy, not a header or query param.
  const url = new URL(`${BASE_URL}/${encodeURIComponent(key)}/${MEDIA_TYPE}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("locale", LOCALE);
  url.searchParams.set("per_page", "24"); // min 8, max 50
  url.searchParams.set("page", "1");

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;

    const json = (await res.json()) as KlipyResponse;
    const urls = (json.data?.data ?? []).map(firstUrl).filter((u): u is string => !!u);
    if (urls.length === 0) return null;

    // Random rather than top-ranked: the same query twice in one conversation
    // otherwise returns the same gif, which reads as a bug.
    return urls[Math.floor(Math.random() * urls.length)];
  } catch {
    // Network error, timeout, or malformed JSON — none worth a retry.
    return null;
  }
}
