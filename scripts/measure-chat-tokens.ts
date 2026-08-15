// What one chat turn costs to send, before the model has written a word.
//
// SCALE-PLAN verification #11. The binding constraint on the whole application
// is Groq's free tier at 8,000 tokens per MINUTE — roughly one turn a minute
// for every user at once — so the per-turn payload IS the concurrency limit.
// Phase B's target is a turn under ~2,500 tokens.
//
// Assembles the real payload by calling the real buildSystemPrompt/buildTools,
// rather than re-stating the prompt here: a copy would drift and start
// reporting a turn nobody sends.
//
// The count is an ESTIMATE. Adding a tokenizer dependency to measure a
// dependency-free path is a poor trade, and the ratio is what matters — the
// same estimator is applied to both sides.
//
// It measures ONE model call. A turn that calls a tool sends the whole payload
// again on the next step, so a real turn costs this number times the step
// count: measured live on 2026-08-14, a 1-message turn with 3 tools reported
// `tokens in=4598 steps=2` against ~2,380 estimated here — two steps of ~2,300,
// so the per-call estimate held and the TURN cost double. Anchor against the
// `[chat] tokens in=… steps=…` line the agent logs on every live turn.
//
// Usage: npm run measure:tokens

import { execSync } from "node:child_process";
import { z } from "zod";
import {
  buildSystemPrompt,
  buildTools,
  type ToolContext,
  type ToolGate,
} from "@/lib/chat/agent";

// The pre-diet prompt, read out of git rather than pasted here — a pasted copy
// would be a second thing to keep in sync and would quietly stop being the
// "before" it claims to be. `main` is the last commit before this phase.
function priorSystemPrompt(): string | null {
  try {
    const source = execSync("git show main:lib/chat/agent.ts", { encoding: "utf8" });
    // The old prompt was one template literal and contained no backticks.
    const match = source.match(/const SYSTEM_PROMPT = `([\s\S]*?)`;/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

// ~4 characters per token for English prose, the usual rule of thumb for
// Llama-family tokenizers. Deliberately crude; see the note above.
const CHARS_PER_TOKEN = 4;
const estimate = (text: string) => Math.round(text.length / CHARS_PER_TOKEN);

const ctx: ToolContext = {
  userId: "00000000-0000-0000-0000-000000000000",
  emit: () => {},
  collectedJobs: [],
  sentMemeThisTurn: false,
  recentMemeIds: [],
  // Only used by the search quota, which this script never reaches — it builds
  // the tool schemas to measure their size and never executes one.
  isAnonymous: true,
};

// Tool schemas are not free: each one ships its name, description and full JSON
// schema on every request. This is the cost the gating in buildTools removes.
function toolCost(gate: ToolGate): { names: string[]; chars: number } {
  const tools = buildTools(ctx, gate);
  let chars = 0;
  for (const [name, t] of Object.entries(tools)) {
    const schema = z.toJSONSchema((t as { inputSchema: z.ZodType }).inputSchema);
    chars += name.length + ((t as { description?: string }).description ?? "").length;
    chars += JSON.stringify(schema).length;
  }
  return { names: Object.keys(tools), chars };
}

// A representative 20-message transcript: the shape a real conversation has by
// the time it has a profile and a search behind it. Lengths matter, wording
// does not.
const TRANSCRIPT = [
  "hey — i'm here, help me find startup jobs",
  "arre welcome. before anything — what's your name?",
  "siddhesh",
  "sahi hai siddhesh. now the important bit: got a resume you can drop in? the + button, resume.",
  "(system: i uploaded my resume and it parsed. here's what you extracted: backend engineer, 2 yrs, node/postgres/aws, three projects)\nreact to this naturally, then keep going.",
  "ok that's a solid backend stack. quick one — where are you, and are you open to remote only or onsite too?",
  "pune, remote preferred but open to hybrid",
  "got it. company size — sub-10 chaos, 10-50, 50-200, or doesn't matter?",
  "10-50 sounds right",
  "chal, running a search on that now.",
  "(showed 8 job cards: Backend Engineer @ Acme, Platform Engineer @ Beta, Founding Engineer @ Gamma, API Engineer @ Delta, Backend Dev @ Epsilon, +3 more)",
  "8 hits. two of these actually want exactly what you've built — baaki is the usual 'entry level, 5 yrs exp' comedy. start with the top one?",
  "yeah the acme one looks good, what do you think",
  "acme's the strongest of the lot — they want node and postgres and you've shipped both. gap is k8s, real but not a dealbreaker. want me to draft the outreach?",
  "sure",
  "drafts are on the card itself — hit 'draft outreach' and you'll get an email plus a linkedin dm.",
  "applied to acme just now",
  "noted, marked it. that one's off future searches. want me to pull a fresh set or chase anything that's gone quiet?",
  "fresh set please",
  "on it — same filters, minus what you've already applied to.",
];

const SUMMARY =
  "Candidate is Siddhesh, backend engineer, ~2 years, node/postgres/aws, resume on file with three projects. Based in Pune, prefers remote but open to hybrid, wants companies in the 10-50 range. One search run: 8 matches, Acme Backend Engineer the strongest fit, k8s the one gap. Applied to Acme, marked. Energy is focused and businesslike, no jokes needed.";

function report(
  label: string,
  gate: ToolGate,
  transcript: string[],
  summary?: string,
  systemOverride?: string,
) {
  const tools = toolCost(gate);
  const system = systemOverride ?? buildSystemPrompt(buildTools(ctx, gate), gate, summary);
  const history = transcript.join("\n");

  const systemTokens = estimate(system);
  const toolTokens = Math.round(tools.chars / CHARS_PER_TOKEN);
  const historyTokens = estimate(history);
  const total = systemTokens + toolTokens + historyTokens;

  console.log(`\n${label}`);
  console.log(`  system prompt   ${String(systemTokens).padStart(5)} tokens`);
  console.log(`  tool schemas    ${String(toolTokens).padStart(5)} tokens  (${tools.names.length}: ${tools.names.join(", ")})`);
  console.log(`  transcript      ${String(historyTokens).padStart(5)} tokens  (${transcript.length} messages)`);
  console.log(`  TOTAL           ${String(total).padStart(5)} tokens`);
  return total;
}

async function main() {
  console.log("Estimated per-turn payload — system prompt + tool schemas + transcript.");
  console.log("Groq free tier: 8,000 tokens/minute, shared by everyone using the app.");

  // What the old stateless route sent: every tool every time, the whole prompt
  // every time (onboarding included, forever), and RAW_KEEP=12 raw messages
  // with a summary on top that was rebuilt from scratch every single turn.
  const prior = priorSystemPrompt();
  if (!prior) {
    console.error("\nCould not read the pre-diet prompt from `git show main:lib/chat/agent.ts`.");
    console.error("The BEFORE row needs it — is `main` still present in this checkout?");
    process.exit(1);
  }
  const priorSystem = `${prior}\n\nEARLIER IN THIS CONVERSATION (summarized — treat as established fact, don't re-ask):\n${SUMMARY}`;

  const before = report(
    "BEFORE (Phase A: all 6 tools, full prompt, RAW_KEEP=12)",
    { canSearch: true, hasSearched: true },
    TRANSCRIPT.slice(-12),
    SUMMARY,
    priorSystem,
  );

  const after = report(
    "AFTER (Phase B: gated tools, trimmed prompt, RAW_KEEP=8)",
    { canSearch: true, hasSearched: true },
    TRANSCRIPT.slice(-8),
    SUMMARY,
  );

  console.log("\nFirst turn of a brand-new visitor, where the gating does the most work:");
  report(
    "  new user (no profile, no search — 3 tools)",
    { canSearch: false, hasSearched: false },
    TRANSCRIPT.slice(0, 1),
  );

  const saved = Math.round(((before - after) / before) * 100);
  console.log(`\n${before} -> ${after} tokens per turn (${saved}% smaller).`);
  console.log(
    // 24k, not 8k: groq meters tokens PER MODEL, and chatModelChain() stacks
    // three chat-capable groq models on one account (8k each, measured from the
    // x-ratelimit headers in Phase D). The old line here said "one 8k key" and
    // understated real capacity by 3x.
    //
    // Still an OPTIMISTIC ceiling, for the reason Phase B found: this estimates
    // ONE model call, and stopWhen: stepCountIs(6) means a turn that calls a
    // tool pays the payload again on every step. Size quotas off the
    // `[chat] tokens … steps=` log on a real transcript, not off this number.
    `concurrent turns per minute across the 24k chat pool: ${Math.floor(24000 / before)} -> ${Math.floor(24000 / after)}`,
  );
  console.log(
    "\nAnd the second call that is gone entirely: the old route re-summarized every",
  );
  console.log(
    "message past the window on EVERY turn. That is a whole extra LLM call per turn,",
  );
  console.log("against the same budget. The rolling summary folds ~3 times per 40 turns.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
