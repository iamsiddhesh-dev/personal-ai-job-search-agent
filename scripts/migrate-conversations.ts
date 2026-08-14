// Gives conversations a database (SCALE-PLAN, Phase B). Until now the whole
// transcript lived in a useRef on the client and was replayed to a stateless
// /api/chat — a refresh, a tab close or the back button destroyed it.
//
// Same approach as migrate-auth.ts: hand-written DDL rather than drizzle-kit's
// interactive generate/push, which cannot run in this environment.
//
// Deliberately runs BEFORE any code reads these tables. New tables that nothing
// references yet break nothing, so this is safe to apply to the live database
// ahead of the routes that use it.

import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

async function main() {
  // Same guard as migrate-lock-postgrest.ts, for the same reason: this script
  // enables RLS at the bottom, and enabling it from a role that does NOT bypass
  // it would make the app's own reads return nothing. Checked before anything
  // is created, so a wrong role changes nothing at all.
  const check = await db.execute(sql`
    SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user
  `);
  const role = check[0] as { rolbypassrls: boolean; rolsuper: boolean } | undefined;
  if (!role?.rolbypassrls && !role?.rolsuper) {
    throw new Error(
      "The role behind DATABASE_URL does not bypass RLS. Enabling it below would " +
        "hide these tables from the app itself. Aborting without changing anything.",
    );
  }

  // summary/summary_through are the rolling summary: `summary` covers exactly
  // the first `summary_through` messages of this conversation, and nothing
  // past them. Every turn folds only what has newly fallen out of the raw
  // window, instead of re-summarizing the whole history the way the stateless
  // route did (3 LLM calls over a 40-turn conversation instead of 28).
  //
  // user_id stays ON DELETE NO ACTION like every other FK here. That is what
  // makes mergeUsers() fail loudly if it ever forgets to re-point conversations
  // before deleting the anonymous row — the failure mode lib/account/merge.ts
  // deliberately wants. Phase C owns the cascade migration.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS conversations (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id         uuid NOT NULL REFERENCES users(id),
      title           text,
      summary         text,
      summary_through integer NOT NULL DEFAULT 0,
      created_at      timestamptz NOT NULL DEFAULT now(),
      updated_at      timestamptz NOT NULL DEFAULT now(),
      archived_at     timestamptz
    )
  `);

  // The only listing query there is: this user's live threads, newest first.
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS conversations_user_updated_idx
      ON conversations (user_id, updated_at DESC)
  `);

  // `ordinal` is not decoration and not a duplicate of created_at. summary_through
  // counts messages from the start of the thread, so "which messages are already
  // folded" is only meaningful under a total order that can never change or tie.
  // Two messages from one turn (a meme and the reply that follows it) are
  // inserted milliseconds apart and CAN share a created_at; ordering by it would
  // let them swap places between two loads, which silently shifts what the
  // summary is believed to cover. A sequence cannot tie and cannot reorder.
  //
  // content is the model-facing text — exactly what historyRef held. display is
  // UI-only extras: matchIds for a jobs card, url/alt for a meme. Deliberately
  // NOT the hydrated RankedMatch[]: a search returns up to 40 matches and
  // lib/agent/persist.ts already wrote all of it to `matches`, so the ids are
  // rehydrated by joining matches -> jobs -> companies instead of duplicating
  // ~40 KB of jsonb per message.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS messages (
      id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      ordinal         bigserial NOT NULL,
      role            text NOT NULL,
      kind            text NOT NULL DEFAULT 'text',
      content         text NOT NULL,
      display         jsonb,
      created_at      timestamptz NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS messages_conversation_ordinal_idx
      ON messages (conversation_id, ordinal)
  `);

  // Not optional, and the reason this is at the bottom of the same script rather
  // than in a follow-up: migrate-lock-postgrest.ts enumerated the nine tables
  // that existed on 2026-08-14, so RLS is NOT inherited by anything created
  // afterwards. A new table in the public schema is exposed through Supabase's
  // auto-generated PostgREST API (/rest/v1/*) to anyone holding the published
  // NEXT_PUBLIC_SUPABASE_ANON_KEY — read AND write — the moment it exists.
  // These two tables hold every word of every conversation, which is strictly
  // more sensitive than what that exposure already covered once.
  //
  // Enabling RLS with no policies is a deny-all for the anon/authenticated
  // roles and a no-op for the app, whose role bypasses RLS (guarded above).
  // Tenancy still lives in application code, exactly as SCALE-PLAN decided.
  for (const table of ["conversations", "messages"]) {
    await db.execute(sql.raw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
    console.log(`  rls enabled: ${table}`);
  }

  const unlocked = await db.execute(sql`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity
  `);
  console.log(
    "conversations and messages created.",
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
