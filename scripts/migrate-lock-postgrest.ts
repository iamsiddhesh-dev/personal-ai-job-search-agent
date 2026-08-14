// Shuts the PostgREST door that Phase A opened.
//
// Publishing the anon key is normally safe, because RLS is what actually
// guards the data. This project deliberately has no RLS (SCALE-PLAN, Decisions)
// — correctly, since the app connects through the pooler as `postgres`, which
// bypasses RLS, so RLS could never enforce tenancy here. But that reasoning
// only covers the app's own connection. It says nothing about the OTHER door
// into the same database: Supabase's auto-generated PostgREST API at
// /rest/v1/*, which is reachable by anyone holding the anon key.
//
// Before Phase A the anon key was not published anywhere. Phase A puts it in
// the browser bundle by necessity (NEXT_PUBLIC_SUPABASE_ANON_KEY), so it is
// public by definition from the first deploy. Measured on 2026-08-14 with that
// key and no session: every table returned rows, including profiles.resume_text
// and profiles.resume_facts — every user's resume — and a zero-row PATCH came
// back 200, meaning writes were permitted too.
//
// Enabling RLS with NO policies is a deny-all for the anon and authenticated
// roles, and a no-op for the app: `postgres` has rolbypassrls and owns every
// table (verified before running this). This is not the tenancy mechanism
// SCALE-PLAN ruled out — tenancy stays in application code, exactly as decided.
// It is a lock on an API this app never intended to expose.
//
// To reverse: ALTER TABLE <name> DISABLE ROW LEVEL SECURITY.

import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

async function main() {
  // Guard rather than assume. If the connecting role could NOT bypass RLS,
  // enabling it here would take the live site down on the next request, and a
  // migration that can do that must refuse to run rather than find out.
  const check = await db.execute(sql`
    SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user
  `);
  const role = check[0] as { rolbypassrls: boolean; rolsuper: boolean } | undefined;
  if (!role?.rolbypassrls && !role?.rolsuper) {
    throw new Error(
      "The role behind DATABASE_URL does not bypass RLS. Enabling it would break " +
        "every query the app makes. Aborting without changing anything.",
    );
  }

  // Every table in the public schema, including the shared ones. jobs and
  // companies carry no personal data, but there is no reason to hand out a
  // free scrape of the harvested job corpus either, and llm_cache rows are
  // keyed on prompt hashes derived from resume text.
  const tables = [
    "users",
    "profiles",
    "runs",
    "matches",
    "drafts",
    "applications",
    "jobs",
    "companies",
    "llm_cache",
  ];

  for (const table of tables) {
    // Safe to run twice: enabling RLS on a table that already has it is a no-op.
    await db.execute(sql.raw(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
    console.log(`  rls enabled: ${table}`);
  }

  const after = await db.execute(sql`
    SELECT count(*) FILTER (WHERE rowsecurity) AS locked,
           count(*)                            AS total
    FROM pg_tables WHERE schemaname = 'public'
  `);
  console.log("public schema:", after[0]);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
