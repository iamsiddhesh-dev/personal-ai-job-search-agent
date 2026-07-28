// Meme selection: curated pack first, Klipy search second, nothing third.
//
// The order is the whole design. The catalog is small but tone-checked, so it
// wins whenever it has something for the mood; Klipy covers everything else and
// stays current; and returning null is a legitimate outcome the caller must
// handle, not an error — an agent that skips a meme is fine, an agent that
// renders a broken image is not.

import { memesForMood, type MemeMood } from "./catalog";
import { searchKlipy } from "./klipy";

export type { MemeMood };
export { MEME_MOODS } from "./catalog";

export interface PickedMeme {
  /** Either a local /memes/... path or an absolute Klipy URL. */
  url: string;
  alt: string;
  source: "catalog" | "klipy";
  /** Catalog id, so callers can avoid repeating it. Absent for Klipy hits. */
  id?: string;
}

export interface PickMemeOptions {
  mood: MemeMood;
  /** Free-text search terms for the Klipy fallback. */
  query?: string;
  /** Catalog ids already sent in this conversation. */
  exclude?: readonly string[];
}

export async function pickMeme({
  mood,
  query,
  exclude = [],
}: PickMemeOptions): Promise<PickedMeme | null> {
  const candidates = memesForMood(mood, exclude);
  if (candidates.length > 0) {
    const meme = candidates[Math.floor(Math.random() * candidates.length)];
    return { url: meme.file, alt: meme.alt, source: "catalog", id: meme.id };
  }

  // Fall back to search. The mood is appended so a vague query still lands in
  // roughly the right emotional territory.
  const terms = query?.trim() ? `${query.trim()} meme` : `${mood.replace(/-/g, " ")} meme`;
  const url = await searchKlipy(terms);
  if (!url) return null;

  return { url, alt: `${mood.replace(/-/g, " ")} reaction gif`, source: "klipy" };
}
