// One-off migration for the llm_cache table (see db/schema.ts). Same approach
// as migrate-phase5.ts / migrate-lead-proof.ts — direct DDL rather than
// drizzle-kit's interactive generate/push.

import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

async function main() {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS llm_cache (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      task text NOT NULL,
      prompt_hash text NOT NULL,
      result jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT llm_cache_task_hash_unique UNIQUE (task, prompt_hash)
    )
  `);
  console.log("llm_cache table created.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
