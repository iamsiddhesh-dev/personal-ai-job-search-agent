// One-time migration: switch the embedding columns from Gemini's 3072-dim
// vectors to Voyage's 1024-dim vectors. Existing embeddings can't be cast
// across dimensions, so they are cleared first (they get re-embedded by the
// Voyage backfill — `npm run embed-jobs`). Idempotent-ish: safe to re-run.
//
// Run: npm run migrate:voyage   (after the schema.ts dims are 1024)

import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

async function main() {
  console.log("clearing old (Gemini 3072-dim) embeddings so the column can be re-typed…");
  await db.execute(sql`UPDATE jobs SET embedding = NULL WHERE embedding IS NOT NULL`);
  await db.execute(sql`UPDATE profiles SET embedding = NULL WHERE embedding IS NOT NULL`);

  console.log("altering vector columns to 1024 dims…");
  await db.execute(sql`ALTER TABLE jobs ALTER COLUMN embedding TYPE vector(1024)`);
  await db.execute(sql`ALTER TABLE profiles ALTER COLUMN embedding TYPE vector(1024)`);

  console.log("done — jobs/profiles embeddings cleared, columns are now vector(1024).");
  console.log("next: `npm run embed-jobs` (Voyage) to backfill, and rebuild any profile.");
  process.exit(0);
}

main().catch((e) => {
  console.error("MIGRATION FAILED");
  console.error(e);
  process.exit(1);
});
