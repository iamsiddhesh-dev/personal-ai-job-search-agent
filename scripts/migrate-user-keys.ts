// Bring-your-own-key storage (SCALE-PLAN Phase D.1).
//
// Same approach as migrate-auth.ts and migrate-conversations.ts: hand-written
// DDL rather than drizzle-kit's interactive generate/push, which cannot run in
// this environment. See AGENTS.md.
//
// Safe to apply ahead of the code that reads it — a new table nothing
// references yet breaks nothing.

import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

async function main() {
  // Same guard as migrate-lock-postgrest.ts and migrate-conversations.ts, for
  // the same reason: this script enables RLS at the bottom, and enabling it
  // from a role that does NOT bypass it would hide the table from the app
  // itself. Checked before anything is created, so a wrong role changes
  // nothing at all.
  const check = await db.execute(sql`
    SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user
  `);
  const role = check[0] as { rolbypassrls: boolean; rolsuper: boolean } | undefined;
  if (!role?.rolbypassrls && !role?.rolsuper) {
    throw new Error(
      "The role behind DATABASE_URL does not bypass RLS. Enabling it below would " +
        "hide this table from the app itself. Aborting without changing anything.",
    );
  }

  // `ciphertext` is AES-256-GCM under ENCRYPTION_KEY, bound to (user_id,
  // provider) as additional authenticated data — a row moved between users
  // will not decrypt. `last4` is the only part of the key that may ever be
  // read back out; the plaintext is never stored and never returned.
  //
  // user_id stays ON DELETE NO ACTION like every other FK in this schema. That
  // is what makes lib/account/merge.ts fail loudly if it ever has to re-point
  // these rows and forgets — the failure mode Phase C deliberately preserved
  // by NOT adding cascades. lib/account/delete.ts deletes them explicitly.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS user_api_keys (
      id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id      uuid NOT NULL REFERENCES users(id),
      provider     text NOT NULL,
      ciphertext   text NOT NULL,
      last4        text NOT NULL,
      created_at   timestamptz NOT NULL DEFAULT now(),
      last_used_at timestamptz
    )
  `);

  // One key per provider per user. Re-submitting replaces rather than
  // accumulating, so "which of their keys" is never a question the routing
  // layer has to answer.
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS user_api_keys_user_provider_unique
      ON user_api_keys (user_id, provider)
  `);

  // Not optional, and more important here than for any table before it.
  // migrate-lock-postgrest.ts enumerated the nine tables that existed on
  // 2026-08-14, so RLS is NOT inherited by anything created afterwards, and a
  // new public table is exposed through Supabase's auto-generated PostgREST API
  // (/rest/v1/*) to anyone holding the published NEXT_PUBLIC_SUPABASE_ANON_KEY —
  // read AND write — from the moment it exists.
  //
  // Phase A's exposure incident is the direct precedent, and this table is a
  // strictly worse version of it: not resumes or chat transcripts, but OTHER
  // PEOPLE'S PROVIDER CREDENTIALS. They are encrypted, so the anon key alone
  // would not yield a usable key — but it would yield the ciphertexts, the
  // last4s, and who has an account where, and a WRITE would let an attacker
  // swap in their own ciphertext. Encryption is the second line here, not the
  // first.
  await db.execute(sql`ALTER TABLE user_api_keys ENABLE ROW LEVEL SECURITY`);
  console.log("  rls enabled: user_api_keys");

  const unlocked = await db.execute(sql`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity
  `);
  console.log(
    "user_api_keys created.",
    unlocked.length === 0
      ? "every public table has RLS on."
      : `WARNING — public tables without RLS: ${unlocked.map((r) => r.tablename).join(", ")}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
