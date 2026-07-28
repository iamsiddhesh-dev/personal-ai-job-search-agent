import type { RankedMatch } from "@/lib/agent/match";


export interface ChatMessage {
  id: string;
  role: "agent" | "user";
  kind: "text" | "jobs" | "meme";
  text?: string;
  jobs?: RankedMatch[];
  // "meme" only. `text` doubles as the caption under the image.
  imageUrl?: string;
  imageAlt?: string;
}

// A LinkedIn PDF export and a resume are both parsed as PDFs but land in
// different profile columns, so the upload has to say which it is.
export type AttachKind = "resume" | "linkedin";

export type { RankedMatch };
