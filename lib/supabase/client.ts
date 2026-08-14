"use client";

// Browser-side Supabase client. Only needed for the calls that must originate
// in the browser because they end in a redirect the user has to follow:
// linkIdentity() and signInWithOAuth(). Everything else about identity is
// resolved server-side in lib/user.ts.

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAuthEnv } from "./env";

let cached: SupabaseClient | undefined;

// Unlike the server client, this one SHOULD be reused. There is exactly one
// user in a browser tab, and a fresh client per call would re-read cookies and
// re-attach auth listeners on every render.
//
// Null when auth is not configured, which is what the account menu checks to
// decide whether to offer sign-in at all — better than offering a button that
// fails after a round trip to Google.
export function createClient(): SupabaseClient | null {
  const env = supabaseAuthEnv();
  if (!env) return null;
  cached ??= createBrowserClient(env.url, env.anonKey);
  return cached;
}
