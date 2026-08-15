// Managing the provider API keys a user brings themselves (SCALE-PLAN D.1).
//
//   GET    — which providers this user has a key for, masked. Never the key.
//   PUT    — store or replace one. Body: { provider, apiKey }.
//   DELETE — remove one. Body: { provider }.
//
// SIGNED-IN ACCOUNTS ONLY. Anonymous visitors get 403 on the two writing
// verbs. The rule is a decision, not a technical limit (owner, 2026-08-15):
// whether anonymous visitors keep any data at all is still open, and storing
// someone's provider credential against a row that may be made throwaway is
// the one version of BYOK that could actually hurt them. GET is allowed for
// everyone so the UI can render "sign in to use your own key" from one call.
//
// The plaintext key appears in exactly one place in this file — the PUT body —
// and goes straight into saveKey(), which encrypts it. It is never echoed back,
// never logged, and never included in an error message.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/db/schema";
import { getOrCreateUser } from "@/lib/user";
import { encryptionAvailable, EncryptionUnavailableError } from "@/lib/keys/crypto";
import { deleteKey, isByokProvider, listKeys, saveKey } from "@/lib/keys/store";

// A key is a credential, not free text. These bounds reject an obviously-wrong
// paste (a whole curl command, an empty box, someone's resume) before it is
// encrypted and stored, without pretending to validate a format that each
// provider is free to change.
const MIN_KEY_LENGTH = 20;
const MAX_KEY_LENGTH = 512;

async function currentAccount() {
  const userId = await getOrCreateUser();
  const [row] = await db
    .select({ isAnonymous: users.isAnonymous })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return { userId, isAnonymous: row?.isAnonymous ?? true };
}

export async function GET() {
  const { userId, isAnonymous } = await currentAccount();
  return Response.json({
    // Both flags are what the UI needs to decide between "add a key", "sign in
    // first", and "the operator hasn't configured this".
    canUseByok: !isAnonymous,
    available: encryptionAvailable(),
    keys: await listKeys(userId),
  });
}

export async function PUT(req: Request) {
  const { userId, isAnonymous } = await currentAccount();
  if (isAnonymous) {
    return Response.json(
      { error: "Sign in first — your own API key is stored against your account." },
      { status: 403 },
    );
  }

  let body: { provider?: unknown; apiKey?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  if (!isByokProvider(body.provider)) {
    return Response.json(
      { error: "Unknown provider. Use one of: groq, google, cerebras." },
      { status: 400 },
    );
  }

  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (apiKey.length < MIN_KEY_LENGTH || apiKey.length > MAX_KEY_LENGTH) {
    // Says what is wrong without quoting the value back — an error message is a
    // place a secret can end up in a log or a screenshot.
    return Response.json(
      { error: "That doesn't look like an API key. Paste the whole key, nothing else." },
      { status: 400 },
    );
  }

  try {
    const summary = await saveKey(userId, body.provider, apiKey);
    // Logged by provider and last4 only. Never the key.
    console.log(`[keys] ${userId} stored a ${body.provider} key ${summary.last4}`);
    return Response.json({ key: summary });
  } catch (err) {
    if (err instanceof EncryptionUnavailableError) {
      // Refuses rather than storing plaintext. 503 because it is the server's
      // configuration that is missing, not the user's request that is wrong.
      console.error("[keys] refused to store a key: ENCRYPTION_KEY is not configured.");
      return Response.json(
        { error: "Bring-your-own-key isn't available on this deployment yet." },
        { status: 503 },
      );
    }
    throw err;
  }
}

export async function DELETE(req: Request) {
  const { userId, isAnonymous } = await currentAccount();
  if (isAnonymous) {
    return Response.json({ error: "Sign in first." }, { status: 403 });
  }

  let body: { provider?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }

  if (!isByokProvider(body.provider)) {
    return Response.json({ error: "Unknown provider." }, { status: 400 });
  }

  const removed = await deleteKey(userId, body.provider);
  if (removed) console.log(`[keys] ${userId} removed their ${body.provider} key`);
  // 200 either way: "there is no key for this provider" is the state the caller
  // asked for, whether or not this request is what produced it.
  return Response.json({ removed });
}
