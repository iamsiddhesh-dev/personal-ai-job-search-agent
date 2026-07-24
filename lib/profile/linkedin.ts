// LinkedIn has no free/legal scraping path (REVISED-PLAN.md §3). Supported
// input is the user's own PDF export — either the quick "Save to PDF" on
// their profile, or LinkedIn's official "Download your data" archive
// (Settings -> Data Privacy -> Download your data). A bare profile URL
// cannot be read — callers must surface that to the user rather than
// silently returning nothing.

import { extractResumeText } from "./resume";

export interface LinkedinResult {
  text: string | null;
  note: string | null;
}

export async function parseLinkedinInput(input: {
  bytes?: Uint8Array;
  url?: string;
}): Promise<LinkedinResult> {
  if (input.bytes) {
    const text = await extractResumeText(input.bytes, "pdf");
    return { text, note: null };
  }
  if (input.url) {
    return {
      text: null,
      note:
        "LinkedIn profile URLs can't be read automatically (no free API, and scraping violates LinkedIn's ToS). " +
        "Two ways to give me your LinkedIn data instead: " +
        "(1) quickest — on your profile, tap 'More' → 'Save to PDF' and upload that; or " +
        "(2) LinkedIn's official export — Settings → 'Data Privacy' tab → 'Download your data' → follow the steps " +
        "(LinkedIn notes this is optimized for the desktop site and the file can take a while to arrive).",
    };
  }
  return { text: null, note: null };
}
