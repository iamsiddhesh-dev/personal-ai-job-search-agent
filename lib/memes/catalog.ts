// The curated meme pack. Hand-picked images beat a live search on the beats
// that matter most (rejection, ghosting, an offer) because tone is everything
// there, and a search API will happily return something that lands wrong.
//
// The catalog is deliberately allowed to be EMPTY: entries point at files in
// public/memes/, and if the array is bare pickMeme falls through to Tenor and
// then to sending nothing at all. Nothing breaks, nothing renders broken.
//
// To add one: drop the image in public/memes/, add an entry below, tag it with
// every mood it fits. See public/memes/README.md.

export type MemeMood =
  | "ghosted"
  | "rejected"
  | "low-match"
  | "grind"
  | "first-apply"
  | "offer"
  | "hyped"
  | "market-cooked"
  | "overqualified-underpaid";

export const MEME_MOODS = [
  "ghosted",
  "rejected",
  "low-match",
  "grind",
  "first-apply",
  "offer",
  "hyped",
  "market-cooked",
  "overqualified-underpaid",
] as const satisfies readonly MemeMood[];

export interface Meme {
  id: string;
  /** Path under public/, served as-is. e.g. "/memes/ghosted-01.jpg" */
  file: string;
  moods: MemeMood[];
  lang: "hi" | "en";
  /** Alt text. Also what the model is told it sent, so make it descriptive. */
  alt: string;
}

// Populate as you collect memes. Ships empty so the feature degrades to Klipy
// (or to silence) rather than shipping images nobody picked.
export const MEME_CATALOG: Meme[] = [];

export function memesForMood(mood: MemeMood, exclude: readonly string[] = []): Meme[] {
  return MEME_CATALOG.filter((m) => m.moods.includes(mood) && !exclude.includes(m.id));
}
