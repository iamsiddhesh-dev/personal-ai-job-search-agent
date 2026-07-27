// One-off migration for the leadProject -> leadProof/leadProofType/standoutProject
// schema change (see db/schema.ts). drizzle-kit generate/push's interactive
// rename-vs-drop-create prompt can't run non-interactively here, so this applies
// the column changes directly — same approach as migrate-phase5.ts.

import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

async function main() {
  await db.execute(sql`ALTER TABLE matches ADD COLUMN IF NOT EXISTS lead_proof text`);
  await db.execute(sql`ALTER TABLE matches ADD COLUMN IF NOT EXISTS lead_proof_type text`);
  await db.execute(sql`ALTER TABLE matches ADD COLUMN IF NOT EXISTS standout_project text`);
  // Backfill: every existing row's lead_project was always a project citation.
  await db.execute(sql`UPDATE matches SET lead_proof = lead_project, lead_proof_type = 'project' WHERE lead_project IS NOT NULL AND lead_proof IS NULL`);
  await db.execute(sql`ALTER TABLE matches DROP COLUMN IF EXISTS lead_project`);
  console.log("lead_proof migration applied.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
