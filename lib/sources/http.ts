// Shared fetch helper. Startup sites are frequently dead or slow, so every
// request MUST time out (probe experience: without this the crawl stalls).

export const UA = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

export const REQUEST_TIMEOUT_MS = 9000;

// Returns parsed JSON (or text when json=false). Returns null on any failure —
// non-2xx, timeout, DNS/connection error (Recruitee wrong-slug is a DNS
// failure, not a 404), or malformed body. Callers distinguish "no board" from
// "empty board" by inspecting the parsed value, never by catching here.
export async function fetchJson(url: string): Promise<unknown | null> {
  return request(url, true);
}

export async function fetchText(url: string): Promise<string | null> {
  return request(url, false) as Promise<string | null>;
}

async function request(
  url: string,
  asJson: boolean,
): Promise<unknown | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: UA,
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) return null;
    return asJson ? await res.json() : await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Run `fn` over `items` with a fixed concurrency ceiling.
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (cursor < items.length) {
        const idx = cursor++;
        out[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return out;
}
