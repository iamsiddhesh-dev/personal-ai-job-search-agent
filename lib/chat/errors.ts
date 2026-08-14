// What the user sees when a turn fails.
//
// A provider error is not a user-facing string. One of them reached a chat
// bubble verbatim — an `AI_APICallError` complete with a Google billing URL —
// which reads to the person on the other end as "this app is broken and wants
// my credit card". The real error belongs in the server log; the user gets one
// line in the agent's voice that is honest about which of the three things went
// wrong, and never leaks a provider name, a model id, a quota number or a link.

import { looksLikeQuotaOrServerError } from "@/lib/llm";

export type ChatFailure = "quota" | "timeout" | "unknown";

export function classifyChatFailure(err: unknown): ChatFailure {
  if (isAbortError(err)) return "timeout";
  if (looksLikeQuotaOrServerError(err)) return "quota";
  return "unknown";
}

// AbortSignal.timeout() rejects with a DOMException named TimeoutError; a
// manual abort gives AbortError. The AI SDK wraps both, so match on name and
// message rather than instanceof.
function isAbortError(err: unknown): boolean {
  const name = err instanceof Error ? err.name : "";
  if (name === "AbortError" || name === "TimeoutError") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /aborted|timed? ?out|ran out of time/i.test(msg);
}

const COPY: Record<ChatFailure, string> = {
  // Honest about the cause without the stack trace or the billing link: every
  // free-tier key in the chain is rate-limited, and waiting really does fix it.
  quota: "arre my brain's rate-limited right now — too many people typing at once. give me a minute and hit me again, i'll pick up right here.",
  timeout: "that one took way too long so i bailed on it. try me again — usually i'm quicker than that.",
  unknown: "something glitched on my end, not yours. say that again and i'll have another go?",
};

// Logs the real error server-side, returns the line to show. Always call this
// rather than formatting an error message into a bubble yourself.
export function agentErrorMessage(err: unknown, context: string): string {
  const failure = classifyChatFailure(err);
  console.error(`[chat] ${context} (${failure}):`, err);
  return COPY[failure];
}
