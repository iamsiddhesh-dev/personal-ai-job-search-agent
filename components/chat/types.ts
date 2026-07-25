import type { RankedMatch } from "@/lib/agent/match";

export type InputMode = "text" | "chips" | "sources" | "none";

export interface ChatMessage {
  id: string;
  role: "agent" | "user";
  kind: "text" | "jobs";
  text?: string;
  jobs?: RankedMatch[];
}

export type { RankedMatch };
