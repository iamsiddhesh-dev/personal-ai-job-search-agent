// One-off migration for Phase 5's applications schema change (see
// db/schema.ts). drizzle-kit push's introspection throws on unrelated DB
// state in this environment, so this applies the three column changes
// directly — same approach HANDOFF.md documents for migrate-to-voyage.ts.

import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

async function main() {
  await db.execute(sql`ALTER TABLE applications ALTER COLUMN job_id DROP NOT NULL`);
  await db.execute(sql`ALTER TABLE applications ADD COLUMN IF NOT EXISTS company_name text`);
  await db.execute(sql`ALTER TABLE applications ADD COLUMN IF NOT EXISTS role_title text`);
  console.log("Phase 5 migration applied.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
