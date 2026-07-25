// The 6-step conversation is an explicit state machine (REVISED-PLAN.md §7) —
// deterministic, never left to an LLM to remember. This is the one place the
// script text lives; app/api/chat/route.ts just serves it, and the client
// page drives the actual side effects (upload, matching).

export type StepId =
  | "name"
  | "sources"
  | "playback"
  | "role"
  | "location"
  | "stage"
  | "run";

export interface StepPrompt {
  step: StepId;
  message: string;
  inputMode: "text" | "chips" | "sources" | "none";
  chips?: string[];
  placeholder?: string;
}

export interface ChatContext {
  name?: string;
  playback?: string;
}

export const ROLE_CHIPS = ["FDE", "Full-stack", "AI", "Frontend", "Backend"];
export const LOCATION_CHIPS = ["India", "Remote", "Anywhere"];
export const STAGE_CHIPS = ["<10 people", "10-50 people", "50-200 people", "Any stage"];
export const PLAYBACK_CHIPS = ["Looks right →", "Let me add more"];

export function getPrompt(step: StepId, ctx: ChatContext = {}): StepPrompt {
  switch (step) {
    case "name":
      return {
        step,
        message: "Hey — I'm your job-hunting agent. What's your name?",
        inputMode: "text",
        placeholder: "Your name",
      };

    case "sources":
      return {
        step,
        message: `Nice to meet you, ${ctx.name ?? "there"}. Share whatever you've got — resume, GitHub, LinkedIn, or a portfolio link. At least one, and more is better.`,
        inputMode: "sources",
      };

    case "playback":
      return {
        step,
        message: `${ctx.playback ?? ""}\n\nDoes that look right?`,
        inputMode: "chips",
        chips: PLAYBACK_CHIPS,
      };

    case "role":
      return {
        step,
        message: "What role are you targeting?",
        inputMode: "chips",
        chips: ROLE_CHIPS,
        placeholder: "Or type a role…",
      };

    case "location":
      return {
        step,
        message: "Location / remote preference?",
        inputMode: "chips",
        chips: LOCATION_CHIPS,
      };

    case "stage":
      return {
        step,
        message: "How early-stage do you want to go?",
        inputMode: "chips",
        chips: STAGE_CHIPS,
      };

    case "run":
      return {
        step,
        message: "On it — searching the job database…",
        inputMode: "none",
      };
  }
}

export function teamSizeBucketFromChip(chip: string): "lt10" | "10-50" | "50-200" | "any" {
  if (chip.startsWith("<10")) return "lt10";
  if (chip.startsWith("10-50")) return "10-50";
  if (chip.startsWith("50-200")) return "50-200";
  return "any";
}

export function locationPrefFromChip(chip: string): "india" | "remote" | "anywhere" {
  const c = chip.toLowerCase();
  if (c.includes("india")) return "india";
  if (c.includes("remote")) return "remote";
  return "anywhere";
}

export function roleFocusFromChip(chip: string): string {
  const map: Record<string, string> = {
    fde: "fde",
    "full-stack": "full-stack",
    ai: "ai",
    frontend: "frontend",
    backend: "backend",
  };
  return map[chip.toLowerCase()] ?? chip;
}
