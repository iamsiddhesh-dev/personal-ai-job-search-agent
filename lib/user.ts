// Identity. Every visitor gets a Supabase Auth session — anonymous at first —
// and `users` rows are keyed to it by auth_user_id.
//
// This replaced an anonymous `sh_uid` cookie that WAS the account, which itself
// replaced a "first row in `users`" lookup that let every visitor inherit one
// shared profile. The cookie is still read here, but only to claim the row it
// used to point at; see the adoption step below.
//
// IMPORTANT: `cookies().set()` only works before a response starts streaming,
// so callers must resolve the user in the request scope — never inside a
// ReadableStream's start(), which runs after the headers are gone. See
// app/api/chat/route.ts, which resolves the id up front and passes it down.
// This matters MORE now than it did on the cookie: @supabase/ssr writes session
// cookies on token refresh, so a badly ordered call costs the user their whole
// session rather than nothing at all.
//
// The signature is load-bearing. Six call sites across five routes call this
// and none of them changed in Phase A; keep it `(): Promise<string>`.

import { cookies } from "next/headers";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/db/schema";
import { createClient } from "@/lib/supabase/server";

const USER_COOKIE = "sh_uid";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

// last_seen_at exists for the quota and cleanup work in later phases, where
// hour-level accuracy is plenty. Writing it on every request would mean six
// extra UPDATEs per page interaction against a pooled free-tier connection, so
// it is only refreshed once it has gone stale.
const LAST_SEEN_STALE_MS = 60 * 60 * 1000;

const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: ONE_YEAR_SECONDS,
} as const;

// Guards against a junk cookie reaching the uuid column, where a malformed
// value is a database error rather than a miss. Exported because request bodies
// carrying ids (matchId, profileId) need the same guard for the same reason.
export const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type AuthIdentity = {
  authUserId: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  isAnonymous: boolean;
};

function identityFromMetadata(
  authUserId: string,
  email: unknown,
  isAnonymous: boolean,
  metadata: Record<string, unknown> | undefined,
): AuthIdentity {
  // Google returns the display name under `full_name` and the picture under
  // `avatar_url`, but the OIDC-standard `name`/`picture` also turn up depending
  // on which token the identity was built from. Read both rather than picking
  // one and discovering later that half the accounts render blank.
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  return {
    authUserId,
    email: str(email),
    displayName: str(metadata?.full_name) ?? str(metadata?.name),
    avatarUrl: str(metadata?.avatar_url) ?? str(metadata?.picture),
    isAnonymous,
  };
}

// Returns null when Supabase Auth cannot give us an identity at all — the
// project setting being off, or the auth service being down. Callers fall back
// to the legacy cookie rather than failing the request; see getOrCreateUser.
async function resolveAuthIdentity(): Promise<AuthIdentity | null> {
  const supabase = await createClient();
  if (!supabase) return null; // auth not configured; env.ts has already said so

  // getClaims(), not getSession(). getSession's user object comes straight out
  // of the cookie and auth-js's own docs say it must not be trusted; this value
  // decides whose profile, runs and applications the request can see, so it has
  // to be the verified one.
  const { data, error } = await supabase.auth.getClaims();
  if (error) {
    console.error("[user] getClaims failed:", error.message);
  } else if (data?.claims) {
    const c = data.claims;
    return identityFromMetadata(c.sub, c.email, c.is_anonymous === true, c.user_metadata);
  }

  const { data: signedIn, error: signInError } = await supabase.auth.signInAnonymously();
  if (signInError || !signedIn.user) {
    // Overwhelmingly the likeliest cause is "Allow anonymous sign-ins" being
    // off in the Supabase dashboard, which returns 422
    // anonymous_provider_disabled. It is a project setting, not code, so it
    // cannot be caught by a typecheck or a build — say so in the log, because
    // the symptom downstream is just "everyone is a new user".
    console.error(
      "[user] signInAnonymously failed, falling back to the sh_uid cookie. " +
        "Check that anonymous sign-ins are enabled in the Supabase dashboard. Cause:",
      signInError?.message ?? "no user returned",
    );
    return null;
  }

  const u = signedIn.user;
  return identityFromMetadata(u.id, u.email, u.is_anonymous === true, u.user_metadata);
}

export async function getOrCreateUser(): Promise<string> {
  const store = await cookies();
  const fromCookie = store.get(USER_COOKIE)?.value;
  const legacyId = fromCookie && UUID_RX.test(fromCookie) ? fromCookie : null;

  const identity = await resolveAuthIdentity();
  if (!identity) return legacyCookieUser(store, legacyId);

  // 1. The steady state, and the only branch most requests take.
  const [existing] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      isAnonymous: users.isAnonymous,
      lastSeenAt: users.lastSeenAt,
    })
    .from(users)
    .where(eq(users.authUserId, identity.authUserId))
    .limit(1);

  if (existing) {
    await reconcile(existing, identity);
    return existing.id;
  }

  // 2. Adoption. The request has a session we have never seen, but it may still
  // carry the cookie from before Phase A — in which case there is an existing
  // row holding this person's profile, runs and applications, and it must be
  // claimed rather than replaced. Skipping this step does not error: it hands
  // every existing user a fresh empty account and their data appears to vanish.
  //
  // The predicate is `is_anonymous = true`, NOT `auth_user_id IS NULL`, and the
  // difference is load-bearing. Minting a session and stamping the row happen
  // in the same request, but the session only becomes real when the response
  // reaches the browser — and a cancelled prefetch, a closed tab or a dropped
  // connection discards it. Observed exactly that during Phase A verification:
  // an aborted request adopted a legacy row under an auth uid that then never
  // existed anywhere. Under an IS NULL guard that row is burnt permanently —
  // still holding the user's data, no longer claimable by them. Keying on
  // is_anonymous instead lets the next request re-claim it, so the failure
  // heals itself.
  //
  // It is not a weaker check. Possession of the httpOnly sh_uid cookie WAS the
  // entire account before Phase A, so honouring it for a row that is still
  // anonymous grants nothing that is not already live in production. The
  // moment a row is linked to a real identity it stops being anonymous and
  // this branch will not touch it again.
  //
  // Guarded inside the UPDATE rather than by a prior SELECT, so two concurrent
  // first-requests cannot both claim the same row.
  if (legacyId) {
    const [adopted] = await db
      .update(users)
      .set({
        authUserId: identity.authUserId,
        email: identity.email,
        displayName: identity.displayName,
        avatarUrl: identity.avatarUrl,
        isAnonymous: identity.isAnonymous,
        lastSeenAt: new Date(),
      })
      .where(and(eq(users.id, legacyId), eq(users.isAnonymous, true)))
      .returning({ id: users.id });

    if (adopted) return adopted.id;
  }

  // 3. A genuinely new visitor.
  //
  // onConflictDoUpdate rather than a plain insert: the browser fires several of
  // these routes at once on first paint, and without it the loser of that race
  // gets a unique-violation on auth_user_id instead of the row that the winner
  // just created. DO UPDATE rather than DO NOTHING because DO NOTHING returns
  // no row on conflict, which would leave us with nothing to return.
  const [created] = await db
    .insert(users)
    .values({
      authUserId: identity.authUserId,
      email: identity.email,
      displayName: identity.displayName,
      avatarUrl: identity.avatarUrl,
      isAnonymous: identity.isAnonymous,
      lastSeenAt: new Date(),
    })
    .onConflictDoUpdate({ target: users.authUserId, set: { lastSeenAt: new Date() } })
    .returning({ id: users.id });

  // Keep an sh_uid anchor on new rows too. The cookie is no longer the account,
  // but it is what legacyCookieUser falls back to if Supabase Auth is ever
  // unreachable, and a row with no anchor at all would be unreachable in that
  // window.
  store.set(USER_COOKIE, created.id, COOKIE_OPTIONS);
  return created.id;
}

// SCALE-PLAN's step 3 says to clear the sh_uid cookie once its row is adopted.
// Deliberately not done, here or in the adoption branch above. The cookie is
// the only thing that still points at a pre-Phase-A row, and it is what makes
// both recoveries above possible: re-adoption after a dropped session, and
// legacyCookieUser if Supabase Auth is unreachable. Clearing it converts either
// of those into permanent, user-invisible data loss. It is no longer the
// account — auth_user_id is — so leaving it costs nothing.

type ExistingUser = {
  id: string;
  email: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  isAnonymous: boolean;
  lastSeenAt: Date | null;
};

// Folds anything that changed on the auth side into our row, in one statement
// and only when there is something to write. This is what carries a Google
// display name and avatar across after the anonymous -> Google upgrade: the
// upgrade keeps the same auth uid, so no other code path would ever notice the
// account stopped being anonymous.
async function reconcile(existing: ExistingUser, identity: AuthIdentity): Promise<void> {
  const patch: Partial<typeof users.$inferInsert> = {};

  if (existing.isAnonymous !== identity.isAnonymous) patch.isAnonymous = identity.isAnonymous;
  // Only ever fill these in or update them to a new value — never null a name
  // or avatar we already hold. An anonymous session's claims carry none of
  // this, and a token refresh mid-upgrade would otherwise blank the account.
  if (identity.email && identity.email !== existing.email) patch.email = identity.email;
  if (identity.displayName && identity.displayName !== existing.displayName) {
    patch.displayName = identity.displayName;
  }
  if (identity.avatarUrl && identity.avatarUrl !== existing.avatarUrl) {
    patch.avatarUrl = identity.avatarUrl;
  }

  const seenAgo = existing.lastSeenAt ? Date.now() - existing.lastSeenAt.getTime() : Infinity;
  if (seenAgo > LAST_SEEN_STALE_MS) patch.lastSeenAt = new Date();

  if (Object.keys(patch).length === 0) return;
  await db.update(users).set(patch).where(eq(users.id, existing.id));
}

// The pre-Phase-A identity, kept as a fallback rather than deleted. Supabase
// Auth being misconfigured or down would otherwise take the whole site off the
// air for logged-out visitors, which today is nearly all of them.
async function legacyCookieUser(
  store: Awaited<ReturnType<typeof cookies>>,
  legacyId: string | null,
): Promise<string> {
  if (legacyId) {
    // Restricted to still-anonymous rows on purpose. Possession of the cookie
    // was the whole account before Phase A, so honouring it for an anonymous
    // row is no weaker than what already shipped — but an account that has
    // since been linked to a real Google identity must not be reachable by
    // cookie alone just because the auth service is having a bad day.
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, legacyId), eq(users.isAnonymous, true)))
      .limit(1);
    if (row) return row.id;
  }

  const [created] = await db.insert(users).values({}).returning({ id: users.id });
  store.set(USER_COOKIE, created.id, COOKIE_OPTIONS);
  return created.id;
}

// For scripts and other non-request contexts, where there is no cookie jar and
// `cookies()` would throw. Deliberately does NOT create a user: a script that
// silently minted a fresh row every run would look exactly like data loss.
// Set SEED_USER_ID to target a specific user.
export async function getScriptUser(): Promise<string> {
  const pinned = process.env.SEED_USER_ID;
  if (pinned) {
    const [row] = await db.select({ id: users.id }).from(users).where(eq(users.id, pinned)).limit(1);
    if (!row) throw new Error(`SEED_USER_ID ${pinned} does not exist in the users table.`);
    return row.id;
  }

  const [existing] = await db.select({ id: users.id }).from(users).limit(1);
  if (existing) return existing.id;
  throw new Error(
    "No users exist yet. Open the app in a browser once to create one, or set SEED_USER_ID.",
  );
}
