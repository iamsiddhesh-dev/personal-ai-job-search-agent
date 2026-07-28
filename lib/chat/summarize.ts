// Compacts the older part of a chat transcript into a short factual note, so a
// long-running conversation's per-turn token cost stays flat instead of
// growing with every message (the chat route was resending the whole thread
// every turn, which compounds quickly on an 8000 TPM key).
//
// Deliberately plain text, not extractStructured: a summary is prose, not
// something a downstream caller parses, and reusing the chat model chain here
// keeps it on the same (cheap, tool-capable) keys as the conversation itself
// rather than spending a separate task's budget.

import { generateText, type ModelMessage } from "ai";
import { chatModelChain } from "@/lib/llm";

const SUMMARIZE_PROMPT = `Condense this conversation between a job-hunting agent and a candidate into a short factual note, under 150 words. Anything you drop, the agent will ask for a second time — which reads as not listening. Capture, in this order of priority:
1. The candidate's NAME, and whether a resume/github/linkedin/portfolio has been shared.
2. Stated preferences: role focus, location and remote/hybrid/onsite/relocation stance, company stage or size.
3. Softer qualifiers if mentioned: timeline or urgency, dealbreakers, work authorization, comp expectations.
4. Key background facts the agent has learned, companies/jobs already shown or discussed, and anything marked applied or rejected.
5. The candidate's current mood/energy (e.g. "frustrated after 3 rejections", "hyped about the offer", "burnt out on the search") if the conversation shows one — this keeps the agent's tone consistent after the note replaces the raw messages.
Plain facts, no chit-chat, no commentary on the conversation itself.`;

export async function summarizeTurns(turns: ModelMessage[]): Promise<string> {
  const transcript = turns
    .map((t) => `${t.role}: ${typeof t.content === "string" ? t.content : JSON.stringify(t.content)}`)
    .join("\n");

  const chain = chatModelChain();
  let lastErr: unknown;
  for (const model of chain) {
    try {
      const { text } = await generateText({
        model,
        prompt: `${SUMMARIZE_PROMPT}\n\nCONVERSATION:\n${transcript}`,
      });
      return text.trim();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
