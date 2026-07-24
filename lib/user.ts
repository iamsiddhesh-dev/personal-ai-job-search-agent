// Single-user app for now, but every table already carries user_id
// (REVISED-PLAN.md §2) so multi-user later is config, not a migration.
// This just gets-or-creates the one user row.

import { db } from "@/lib/db";
import { users } from "@/db/schema";

export async function getOrCreateSingleUser(): Promise<string> {
  const [existing] = await db.select().from(users).limit(1);
  if (existing) return existing.id;
  const [created] = await db.insert(users).values({}).returning();
  return created.id;
}
