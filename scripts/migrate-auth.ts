// Adds the Supabase Auth columns to `users` (see db/schema.ts). Same approach
// as migrate-llm-cache.ts — direct DDL rather than drizzle-kit's interactive
// generate/push, which cannot run in this environment.
//
// Deliberately runs BEFORE any code reads these columns. Every column is
// nullable or defaulted, so the existing rows — real users on the live site —
// stay valid the moment this lands, and the app keeps working on the old
// cookie identity until getOrCreateUser() is rewritten.

import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

async function main() {
  // auth_user_id is the Supabase Auth uid (auth.users.id). NULL for every row
  // that predates this migration; those are claimed later by cookie adoption.
  await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_user_id uuid`);
  await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS email text`);
  await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name text`);
  await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url text`);
  await db.execute(
    sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_anonymous boolean NOT NULL DEFAULT true`,
  );
  await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at timestamptz`);

  // A UNIQUE INDEX rather than a UNIQUE CONSTRAINT, because only the index form
  // supports IF NOT EXISTS — ADD CONSTRAINT has no such clause and would throw
  // on the second run. Postgres treats a unique index as a valid conflict
  // target, so ON CONFLICT (auth_user_id) still works against it.
  //
  // Multiple NULLs are allowed under a unique index, which is exactly what we
  // need: every pre-auth row has a NULL auth_user_id and they must not collide.
  await db.execute(
    sql`CREATE UNIQUE INDEX IF NOT EXISTS users_auth_user_id_unique ON users (auth_user_id)`,
  );

  console.log("users auth columns added.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
