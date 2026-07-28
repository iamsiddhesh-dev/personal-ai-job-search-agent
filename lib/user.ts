// Identity. Each browser gets its own anonymous user row, pinned by a cookie.
//
// This replaced a "first row in `users`" lookup, which meant every visitor
// inherited one shared profile — the agent would greet a total stranger by the
// previous user's name because getProfile found their row. There is still no
// login: the cookie IS the account, which is enough for an anonymous tool and
// keeps real auth a later drop-in (every table already carries user_id).
//
// IMPORTANT: `cookies().set()` only works before a response starts streaming,
// so callers must resolve the user in the request scope — never inside a
// ReadableStream's start(), which runs after the headers are gone. See
// app/api/chat/route.ts, which resolves the id up front and passes it down.

import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/db/schema";

const USER_COOKIE = "sh_uid";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

// Guards against a junk cookie reaching the uuid column, where a malformed
// value is a database error rather than a miss.
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getOrCreateUser(): Promise<string> {
  const store = await cookies();
  const fromCookie = store.get(USER_COOKIE)?.value;

  // Confirm the row still exists — a cookie can outlive a wiped database, and
  // trusting it blindly would produce foreign-key failures on every write.
  if (fromCookie && UUID_RX.test(fromCookie)) {
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, fromCookie))
      .limit(1);
    if (row) return row.id;
  }

  const [created] = await db.insert(users).values({}).returning({ id: users.id });
  store.set(USER_COOKIE, created.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: ONE_YEAR_SECONDS,
  });
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
