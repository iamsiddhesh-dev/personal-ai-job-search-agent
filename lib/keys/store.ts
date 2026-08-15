// Reading and writing users' own provider keys (SCALE-PLAN Phase D.1).
//
// The ONLY module that decrypts. Everything else — routes, the chat agent,
// lib/llm — deals in either the masked summary type below or an opaque
// UserKeyring, and never sees a plaintext key it did not just receive from the
// user in a request body.
//
// Two return shapes, deliberately different so they cannot be confused:
//   KeySummary   — safe to serialise to a client. provider, last4, dates.
//   UserKeyring  — plaintext, server-only, for handing to lib/llm.
// Nothing returns both.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { userApiKeys } from "@/db/schema";
import { decryptApiKey, encryptApiKey, maskKey } from "./crypto";
import type { ProviderName } from "@/lib/llm";

// Providers a user may bring a key for. Groq is the one that matters and the
// one the onboarding copy points at — it is the TPM-capped path every chat turn
// runs through, it is free, and it needs no card. The other two are accepted
// because lib/llm already routes to them and refusing would be arbitrary.
export const BYOK_PROVIDERS = ["groq", "google", "cerebras"] as const;
export type ByokProvider = (typeof BYOK_PROVIDERS)[number];

export function isByokProvider(v: unknown): v is ByokProvider {
  return typeof v === "string" && (BYOK_PROVIDERS as readonly string[]).includes(v);
}

/** Safe to send to a client. Contains nothing secret. */
export interface KeySummary {
  provider: ByokProvider;
  last4: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/**
 * Plaintext keys by provider. SERVER ONLY — never serialise this, never log it,
 * never put it in an error. Lives for the duration of one request.
 */
export type UserKeyring = Partial<Record<ProviderName, string>>;

/** What the account UI renders. Never touches the ciphertext column. */
export async function listKeys(userId: string): Promise<KeySummary[]> {
  const rows = await db
    .select({
      provider: userApiKeys.provider,
      last4: userApiKeys.last4,
      createdAt: userApiKeys.createdAt,
      lastUsedAt: userApiKeys.lastUsedAt,
    })
    .from(userApiKeys)
    .where(eq(userApiKeys.userId, userId));

  return rows
    .filter((r): r is typeof r & { provider: ByokProvider } => isByokProvider(r.provider))
    .map((r) => ({
      provider: r.provider,
      last4: r.last4,
      createdAt: r.createdAt.toISOString(),
      lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
    }));
}

/**
 * Store (or replace) a user's key for one provider.
 *
 * Throws EncryptionUnavailableError when ENCRYPTION_KEY is missing — see
 * lib/keys/crypto.ts for why this refuses rather than degrading.
 */
export async function saveKey(
  userId: string,
  provider: ByokProvider,
  plaintext: string,
): Promise<KeySummary> {
  const trimmed = plaintext.trim();
  const ciphertext = encryptApiKey(trimmed, userId, provider);
  const last4 = maskKey(trimmed);

  const [row] = await db
    .insert(userApiKeys)
    .values({ userId, provider, ciphertext, last4 })
    .onConflictDoUpdate({
      target: [userApiKeys.userId, userApiKeys.provider],
      // A replaced key is a NEW key: reset last_used_at so the UI does not
      // claim the fresh one was last used at a time the old one was.
      set: { ciphertext, last4, createdAt: new Date(), lastUsedAt: null },
    })
    .returning({ createdAt: userApiKeys.createdAt, lastUsedAt: userApiKeys.lastUsedAt });

  return {
    provider,
    last4,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}

/** Remove a user's key. Returns whether there was one to remove. */
export async function deleteKey(userId: string, provider: ByokProvider): Promise<boolean> {
  const removed = await db
    .delete(userApiKeys)
    .where(and(eq(userApiKeys.userId, userId), eq(userApiKeys.provider, provider)))
    .returning({ id: userApiKeys.id });
  return removed.length > 0;
}

/**
 * Every usable key this user has, decrypted, for one request's LLM calls.
 *
 * A row that fails to decrypt is SKIPPED, not thrown on: the cause is either a
 * rotated ENCRYPTION_KEY or a tampered row, and in both cases the user's turn
 * should quietly fall back to the shared pool rather than fail. It is logged
 * without the payload so the operator can see it happening.
 *
 * Returns an empty keyring — not null — when there is nothing, so callers can
 * treat "no keys" and "some keys" identically.
 */
export async function keyringFor(userId: string): Promise<UserKeyring> {
  const rows = await db
    .select({
      provider: userApiKeys.provider,
      ciphertext: userApiKeys.ciphertext,
    })
    .from(userApiKeys)
    .where(eq(userApiKeys.userId, userId));

  const keyring: UserKeyring = {};
  for (const row of rows) {
    if (!isByokProvider(row.provider)) continue;
    const plaintext = decryptApiKey(row.ciphertext, userId, row.provider);
    if (!plaintext) {
      console.error(
        `[keys] could not decrypt the ${row.provider} key for ${userId} — falling back to the ` +
          "shared pool. Either ENCRYPTION_KEY changed or the row was altered.",
      );
      continue;
    }
    keyring[row.provider] = plaintext;
  }
  return keyring;
}

/**
 * Mark keys as used, after a turn that actually ran on them.
 *
 * Deliberately fire-and-forget and deliberately coarse: this is a UI nicety
 * ("last used 2 hours ago"), and an extra UPDATE on the critical path of every
 * LLM call is not worth an exact timestamp. Never throws — a failed bookkeeping
 * write must not turn a successful turn into an error.
 */
export async function touchKeys(userId: string, providers: ProviderName[]): Promise<void> {
  if (providers.length === 0) return;
  try {
    await db
      .update(userApiKeys)
      .set({ lastUsedAt: new Date() })
      .where(and(eq(userApiKeys.userId, userId), inArray(userApiKeys.provider, providers)));
  } catch (err) {
    console.error("[keys] could not update last_used_at:", err);
  }
}
