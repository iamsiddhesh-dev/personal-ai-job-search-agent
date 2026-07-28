# Meme pack

Images the agent can send during a conversation. Curated on purpose — these are
the ones that fire on the beats where tone matters most (a rejection, being
ghosted, an offer). Anything not covered here falls through to Klipy search.

## Adding a meme

1. Drop the file in this folder. Keep it small — under ~400KB, `.jpg`, `.png`,
   `.gif`, or `.webp`. These are served straight from `public/`, uncompressed.
2. Add an entry to `MEME_CATALOG` in [`lib/memes/catalog.ts`](../../lib/memes/catalog.ts):

   ```ts
   {
     id: "ghosted-01",
     file: "/memes/ghosted-01.jpg",
     moods: ["ghosted", "market-cooked"],
     lang: "hi",
     alt: "guy staring at his phone waiting for a reply that never comes",
   }
   ```

3. Tag every mood it genuinely fits — more tags means it fires more often, so
   don't over-tag or you'll see the same image everywhere.

## Fields

- **`id`** — unique, kebab-case. Used to avoid repeating a meme in one session.
- **`moods`** — from `MemeMood`: `ghosted`, `rejected`, `low-match`, `grind`,
  `first-apply`, `offer`, `hyped`, `market-cooked`, `overqualified-underpaid`.
- **`lang`** — `"hi"` for Hindi/Hinglish text in the image, `"en"` otherwise.
  Nothing filters on this yet; it's there so language-matching is possible later.
- **`alt`** — real alt text, and also what the model is told it just sent. Write
  it descriptively so the agent doesn't repeat the joke in words.

## Where to find good ones

The curated tier is what carries tone, so it's worth collecting deliberately.
Places with reusable Hinglish/Indian formats:

- **Reddit** — `r/IndianMemes`, `r/indiameme`, `r/IndianDankMemes`. Best source
  for clean, reusable *templates* rather than one-off posts.
- **Instagram** — `@sarcastic_us`, `@desihumor`, `@viralndianofficial`,
  `@jeejaji` (strong Hinglish voice), RVCJ Media.
- Job-hunt-specific beats (rejection, ghosting, "we'll be in touch") are worth
  searching for directly — that's where the agent reaches most often.

Grab the underlying reaction/template format, not a licensed still.

## Notes

- **This folder can be empty.** The catalog ships empty and everything still
  works: `pickMeme` falls through to Klipy search, then to sending no meme at
  all.
- Set `KLIPY_API_KEY` in `.env` to enable the fallback (free key from
  `partner.klipy.com`). Without it, only curated memes ever send.
- Use images you have the right to use. Reaction images and screenshots from
  public meme formats are the usual choice; don't ship anything licensed.
- Refresh occasionally — a meme that was funny two years ago reads as dated.
