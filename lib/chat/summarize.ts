// Compacts the older part of a chat transcript into a short factual note, so a
// long-running conversation's per-turn token cost stays flat instead of
// growing with every message (the chat route was resending the whole thread
// every turn, which compounds quickly on an 8000 TPM key).
//
// ROLLING, since Phase B. The stateless version summarized every message older
// than the raw window on every single turn and then threw the result away — at
// turn 40 that is a fresh summary of 28 messages, every turn, competing with
// the reply itself for the same 8k TPM budget. Now the summary is stored on the
// conversation and only the newly fallen-out messages are folded in, which is
// roughly 3 calls over a 40-turn conversation instead of 28.
//
// Deliberately plain text, not extractStructured: a summary is prose, not
// something a downstream caller parses, and reusing the chat model chain here
// keeps it on the same (cheap, tool-capable) keys as the conversation itself
// rather than spending a separate task's budget.

import { generateText, type ModelMessage } from "ai";
import { chatModelChain, isKeyRejected } from "@/lib/llm";

const SUMMARIZE_PROMPT = `Condense this conversation between a job-hunting agent and a candidate into a short factual note, under 150 words. Anything you drop, the agent will ask for a second time — which reads as not listening. Capture, in this order of priority:
1. The candidate's NAME, and whether a resume/github/linkedin/portfolio has been shared.
2. Stated preferences: role focus, location and remote/hybrid/onsite/relocation stance, company stage or size.
3. Softer qualifiers if mentioned: timeline or urgency, dealbreakers, work authorization, comp expectations.
4. Key background facts the agent has learned, companies/jobs already shown or discussed, and anything marked applied or rejected.
5. The candidate's current mood/energy (e.g. "frustrated after 3 rejections", "hyped about the offer", "burnt out on the search") if the conversation shows one — this keeps the agent's tone consistent after the note replaces the raw messages.
Plain facts, no chit-chat, no commentary on the conversation itself.`;

// Appended when there is already a summary to build on. The instruction to
// EXTEND rather than replace is the whole point: the older messages that
// produced the existing note are gone and will never be seen again, so a model
// that treats this as "summarize the new messages" quietly drops the
// candidate's name and everything else established early in the thread. The
// word limit rises with the note because a fixed one would force the model to
// evict old facts to make room for new ones — the same silent forgetting by a
// different route.
const EXTEND_PROMPT = `You are UPDATING an existing note, not writing a new one. The note below already covers the earlier part of this conversation; those messages are gone and cannot be re-read.

Rewrite the note so it covers BOTH what it already says and the new messages. Keep every fact from the existing note unless a new message actually contradicts it — in which case the newer one wins. Do not drop the name, preferences, or history just because they are not mentioned again below. Stay under 250 words.

EXISTING NOTE:`;

export async function summarizeTurns(
  turns: ModelMessage[],
  priorSummary?: string,
): Promise<string> {
  const transcript = turns
    .map((t) => `${t.role}: ${typeof t.content === "string" ? t.content : JSON.stringify(t.content)}`)
    .join("\n");

  const prior = priorSummary?.trim();
  const prompt = prior
    ? `${SUMMARIZE_PROMPT}\n\n${EXTEND_PROMPT}\n${prior}\n\nNEW MESSAGES:\n${transcript}`
    : `${SUMMARIZE_PROMPT}\n\nCONVERSATION:\n${transcript}`;

  const chain = chatModelChain();
  // Same dead-key skip as runChatTurn, and needed for the same reason: one key
  // now appears once per model in the chain, so a rejected key would otherwise
  // cost this a wasted round trip per model — inside the same 45s turn budget
  // the agent call is already competing for.
  const deadKeys = new Set<string>();
  let lastErr: unknown;
  for (const { model, keyId } of chain) {
    if (deadKeys.has(keyId)) continue;
    try {
      const { text } = await generateText({ model, prompt });
      const summary = text.trim();
      // An empty completion would otherwise be stored as the new summary and
      // silently wipe everything the thread had established. Treat it as a
      // failed hop and let the next model try.
      if (summary) return summary;
      lastErr = new Error("Summarizer returned no text.");
    } catch (err) {
      lastErr = err;
      if (isKeyRejected(err)) deadKeys.add(keyId);
    }
  }
  throw lastErr;
}
