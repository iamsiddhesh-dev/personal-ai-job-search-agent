// Service-role Supabase client, for the two things that need admin rights:
// deleting an auth user, and anything else that must not be scoped to a
// session. Server-only — the key here bypasses every check Supabase has.
//
// NOT lib/supabase/server.ts, which is the per-request session client built on
// the PUBLISHABLE key and carries the caller's identity. Using this one where
// that one belongs makes every request look like the same omnipotent user.
//
// It reads the unprefixed SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY, matching
// lib/storage.ts, which holds its own copy of this client for the resumes
// bucket. Deliberately NOT the NEXT_PUBLIC_ spelling that lib/supabase/env.ts
// insists on: those two are inlined into the browser bundle, and a service role
// key must never be reachable from a variable name with that prefix, even by
// accident.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Null rather than a throw, same convention as supabaseAuthEnv(): an unset
// variable degrades one feature instead of taking a route — or the site — down.
// Callers must say what they did without it.
export function adminClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    console.error(
      "[supabase] admin client unavailable — SUPABASE_URL and/or " +
        "SUPABASE_SERVICE_ROLE_KEY are unset. See .env.example.",
    );
    return null;
  }

  // No session persistence and no auto-refresh: this client is built per call
  // on the server, has no browser storage to persist into, and its authority
  // comes from the key rather than from any session it might cache.
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
