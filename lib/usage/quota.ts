// Per-user daily quotas on the shared provider pool (SCALE-PLAN Phase D.2).
//
// The problem this solves is not abuse, it is arithmetic. The shared Groq
// account carries 24,000 tokens/minute and 1,000 requests/day per model across
// three chat-capable models, and a tool-calling turn costs the full payload on
// every step — a live turn logged `in=4598 steps=2`. So the whole site has
// roughly 1,500 turns a day to hand out, and without a per-user ceiling the
// first person to open twenty tabs takes all of them.
//
// Two rules make this correct rather than decorative:
//
//  1. THE COUNTER LIVES IN POSTGRES. Vercel gives every request a fresh
//     isolate, so an in-process limiter counts to one and forgets. This is the
//     mistake the plan calls out by name and the easy one to make, because a
//     module-level Map works perfectly in local development.
//
//  2. THE CHECK AND THE INCREMENT ARE ONE STATEMENT. Two tabs submitting at
//     once is the ordinary case, not an edge case — Phase B hit exactly this
//     with the rolling-summary watermark. A read-then-write would let both
//     tabs read 39, both decide they are under 40, and both write 40.

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { usageCounters } from "@/db/schema";
import type { ProviderName, CallerKeys } from "@/lib/llm";

export type UsageAction = "chat_turn" | "search";
export const USAGE_ACTIONS: UsageAction[] = ["chat_turn", "search"];

// Which provider normally serves an action. Used only to decide whether a
// user's own key exempts them from that action's quota.
//
// The PRIMARY provider, not every provider the chain could reach. A chain falls
// back to other providers when the primary is throttled, and those fallbacks do
// touch the shared pool — but they only run when the primary is already down,
// which is rare and self-limiting. Charging a BYOK user's quota for that
// possibility would mean their key bought them nothing on the paths they
// actually use. Named here rather than inferred so the exemption rule is one
// readable table instead of a guess spread across two files.
const PRIMARY_PROVIDER: Record<UsageAction, ProviderName> = {
  // chatModelChain() leads with groq.
  chat_turn: "groq",
  // TASK_ROUTES.rerank leads with cerebras; the LLM re-rank is where a search
  // actually spends its tokens.
  search: "cerebras",
};

// Defaults from SCALE-PLAN, overridable without a deploy because the right
// numbers depend on how many people are actually on the site that week.
//
// The arithmetic behind them: ~1,500 turns/day of total capacity (3 chat models
// x 1,000 requests/day, ~2 requests per tool-calling turn). 40/day supports
// ~37 signed-in users at a full allowance, 10/day supports ~150 anonymous ones,
// and in practice almost nobody uses their whole allowance. Searches are capped
// far lower because one search is 3 LLM re-rank calls, not one.
const LIMITS: Record<"anon" | "signedIn", Record<UsageAction, number>> = {
  anon: {
    chat_turn: envInt("QUOTA_ANON_CHAT_TURNS", 10),
    search: envInt("QUOTA_ANON_SEARCHES", 1),
  },
  signedIn: {
    chat_turn: envInt("QUOTA_CHAT_TURNS", 40),
    search: envInt("QUOTA_SEARCHES", 5),
  },
};

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    console.error(`[quota] ${name}=${raw} is not a non-negative integer; using ${fallback}.`);
    return fallback;
  }
  return n;
}

export interface QuotaVerdict {
  allowed: boolean;
  /** Uses INCLUDING this one when allowed; uses so far when not. */
  used: number;
  limit: number;
  /** True when the user's own key means this action was never counted. */
  exempt: boolean;
}

export function limitFor(action: UsageAction, isAnonymous: boolean): number {
  return LIMITS[isAnonymous ? "anon" : "signedIn"][action];
}

/** Does this user's own keyring cover the provider that serves `action`? */
export function isExempt(action: UsageAction, caller: CallerKeys | undefined): boolean {
  return Boolean(caller?.[PRIMARY_PROVIDER[action]]?.trim());
}

/**
 * Count one use of `action` against today's quota, and say whether it is
 * allowed.
 *
 * Atomic by construction. The WHERE on the DO UPDATE is what does the work: if
 * the stored count has already reached the limit the update matches no row, the
 * statement returns nothing, and the counter is NOT incremented — so a blocked
 * user cannot push their own count higher by retrying. When it does update, the
 * returned count is the value after the increment, and no concurrent request
 * can have seen the same one.
 *
 * On the insert path there is no conflict and the row is created at 1, so a
 * limit of 0 has to be handled before the statement runs rather than by it.
 */
export async function consume(
  userId: string,
  action: UsageAction,
  opts: { isAnonymous: boolean; caller?: CallerKeys },
): Promise<QuotaVerdict> {
  const limit = limitFor(action, opts.isAnonymous);

  // Their own key, their own quota — nothing to count. Checked before touching
  // the database, so a BYOK user's turn does not pay for a write it will never
  // read.
  if (isExempt(action, opts.caller)) {
    return { allowed: true, used: 0, limit, exempt: true };
  }

  // A limit of 0 means "never allowed", which the INSERT below cannot express:
  // with no existing row there is no conflict, so it would happily create one
  // at 1. Handled here instead.
  if (limit <= 0) {
    return { allowed: false, used: 0, limit, exempt: false };
  }

  const rows = await db.execute<{ count: number }>(sql`
    INSERT INTO usage_counters (user_id, day, action, count)
    VALUES (${userId}::uuid, current_date, ${action}, 1)
    ON CONFLICT (user_id, day, action) DO UPDATE
      SET count = usage_counters.count + 1
      WHERE usage_counters.count < ${limit}
    RETURNING count
  `);

  if (rows.length === 0) {
    // Blocked. Report the real number so the UI can say how far over they are,
    // read separately since the statement above deliberately returned nothing.
    const [current] = await db
      .select({ count: usageCounters.count })
      .from(usageCounters)
      .where(
        and(
          eq(usageCounters.userId, userId),
          eq(usageCounters.action, action),
          sql`${usageCounters.day} = current_date`,
        ),
      )
      .limit(1);
    return { allowed: false, used: current?.count ?? limit, limit, exempt: false };
  }

  return { allowed: true, used: Number(rows[0].count), limit, exempt: false };
}

/**
 * Today's usage for every action, WITHOUT counting one. For the usage panel.
 */
export async function usageFor(
  userId: string,
  opts: { isAnonymous: boolean; caller?: CallerKeys },
): Promise<Record<UsageAction, QuotaVerdict>> {
  const rows = await db
    .select({ action: usageCounters.action, count: usageCounters.count })
    .from(usageCounters)
    .where(and(eq(usageCounters.userId, userId), sql`${usageCounters.day} = current_date`));

  const byAction = new Map(rows.map((r) => [r.action, r.count]));
  const out = {} as Record<UsageAction, QuotaVerdict>;
  for (const action of USAGE_ACTIONS) {
    const limit = limitFor(action, opts.isAnonymous);
    const exempt = isExempt(action, opts.caller);
    const used = byAction.get(action) ?? 0;
    out[action] = { allowed: exempt || used < limit, used, limit, exempt };
  }
  return out;
}

// In the agent's voice, same rule as lib/chat/errors.ts: honest about the cause,
// no numbers-as-scolding, and it says the thing that actually helps — that an
// own key removes the cap, which is the entire point of having built BYOK.
export function quotaMessage(action: UsageAction, isAnonymous: boolean): string {
  if (action === "search") {
    return isAnonymous
      ? "that's your free search for today — searching is the expensive bit, sorry. sign in and you get five a day, or drop in your own groq key (free, 60 seconds, no card) and i'll stop counting entirely."
      : "you've used up today's searches. they cost me the most, so they're the tightest cap. add your own groq key in the account menu — free, takes a minute — and i'll stop counting.";
  }
  return isAnonymous
    ? "we've hit today's limit for guests — i'm running on a free tier and there's only so much of me to go round. sign in and you get four times as much, or bring your own groq key and i'll stop counting altogether."
    : "that's today's limit on my shared brain, sorry. it resets at midnight UTC. if you'd rather not wait, add your own groq key in the account menu — it's free, takes about a minute, and then none of this applies to you.";
}
