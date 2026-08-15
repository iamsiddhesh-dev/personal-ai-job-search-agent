// Stripping provider API keys out of text before it is stored or sent onward.
//
// The system prompt tells the agent never to ask for a key and never to echo
// one, which stops the app INVITING the mistake — but it cannot stop someone
// pasting one anyway, and by then it is too late for a prompt to help:
// app/api/chat/route.ts stores the user's message BEFORE the turn runs (Phase
// B, deliberately, so a failed turn does not lose what they typed). So a pasted
// key would land in `messages` in plaintext and be replayed to the model
// providers as history on every later turn.
//
// That is not hypothetical. A real user did exactly this on 2026-08-15, after
// the agent hallucinated a bring-your-own-key flow that did not exist yet.
// scripts/redact-secrets.ts cleaned up the one that already landed; this stops
// the next one landing at all.
//
// Deliberately narrow. Each alternative is a provider's documented key prefix
// plus enough trailing entropy that a false positive is implausible. A broad
// "long random-looking string" rule would eat legitimate message content —
// commit hashes, job ids, base64 in a pasted JD — and silently corrupt what
// someone said, which is a worse failure than the one it prevents.
const API_KEY_RX = /(gsk_|sk-[A-Za-z0-9]|csk-|AIza|sk_live_|xoxb-)[A-Za-z0-9_-]{15,}/g;

/** What replaces a key. Short, and says what to do about it. */
export const REDACTED = "[api key removed]";

/** True when the text contains something shaped like a provider API key. */
export function containsApiKey(text: string): boolean {
  // .test() with a /g regex is stateful via lastIndex — build a fresh matcher
  // rather than reusing the module-level one, or every other call returns false.
  return new RegExp(API_KEY_RX.source, "").test(text);
}

/**
 * Replace anything key-shaped with a placeholder.
 *
 * Returns the text unchanged when there is nothing to redact, so the common
 * path allocates nothing.
 */
export function redactApiKeys(text: string): string {
  if (!containsApiKey(text)) return text;
  return text.replace(new RegExp(API_KEY_RX.source, "g"), REDACTED);
}
