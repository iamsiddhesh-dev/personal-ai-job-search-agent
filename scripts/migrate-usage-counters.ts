// Per-user daily quotas (SCALE-PLAN Phase D.2).
//
// Same approach as every migration here: hand-written DDL, not drizzle-kit's
// interactive generate/push. See AGENTS.md.

import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

async function main() {
  // Same guard, same reason as migrate-user-keys.ts: RLS is enabled at the
  // bottom and enabling it from a role that does not bypass it would hide the
  // table from the app itself.
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

  // The composite primary key is load-bearing, not just tidy. lib/usage/quota.ts
  // does its check and its increment in ONE statement —
  //   INSERT ... ON CONFLICT (user_id, day, action) DO UPDATE
  //     SET count = count + 1 WHERE count < $limit
  // — and that requires a unique constraint on exactly this triple to conflict
  // against. Without it two tabs can both read 39, both decide they are under
  // 40, and both write 40.
  //
  // `day` is a DATE, so quotas reset at 00:00 in the database's timezone (UTC
  // on Supabase) rather than the user's local midnight. A per-user local
  // midnight would need a stored timezone and would let someone reset their own
  // quota by changing it.
  //
  // user_id stays ON DELETE NO ACTION like every other FK here; lib/account/
  // delete.ts removes these rows explicitly.
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS usage_counters (
      user_id uuid NOT NULL REFERENCES users(id),
      day     date NOT NULL,
      action  text NOT NULL,
      count   integer NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, day, action)
    )
  `);

  // Lets the daily sweep drop old rows without scanning the table. The counters
  // are only ever read for `current_date`, so everything older is dead weight
  // the moment the day rolls over.
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS usage_counters_day_idx ON usage_counters (day)
  `);

  // Not optional — see migrate-conversations.ts and migrate-user-keys.ts. A new
  // public table is readable AND writable through the published
  // NEXT_PUBLIC_SUPABASE_ANON_KEY via PostgREST from the moment it exists, and
  // for this table a write is the interesting attack: anyone could reset their
  // own counter to zero, which would make the whole quota system decorative.
  await db.execute(sql`ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY`);
  console.log("  rls enabled: usage_counters");

  const unlocked = await db.execute(sql`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity
  `);
  console.log(
    "usage_counters created.",
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
