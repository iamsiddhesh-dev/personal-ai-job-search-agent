// LinkedIn has no free/legal scraping path (REVISED-PLAN.md §3). The only
// supported input is the user's own "Save to PDF" export, uploaded like a
// resume. A bare profile URL cannot be read — callers must surface that to
// the user rather than silently returning nothing.

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
        "Please export your profile as a PDF — LinkedIn → 'More' on your profile → 'Save to PDF' — and upload that instead.",
    };
  }
  return { text: null, note: null };
}
