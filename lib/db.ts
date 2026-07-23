import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "@/db/schema";

// Supabase transaction pooler (port 6543) does not support session-level
// prepared statements, since each transaction can land on a different
// backend connection. Must disable them here or queries fail intermittently.
const client = postgres(process.env.DATABASE_URL!, { prepare: false });

export const db = drizzle(client, { schema });
