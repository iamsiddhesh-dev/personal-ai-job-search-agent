// Server-side Supabase auth client, built over Next's cookie store.
//
// NOT the client in lib/storage.ts. That one holds the service role key and
// talks to the private `resumes` bucket; it has no cookie handling and is
// privileged. Sessions need their own client or every request looks like the
// same omnipotent user.
//
// IMPORTANT — the constraint from lib/user.ts:9 applies to everything here.
// @supabase/ssr writes session cookies on token refresh, not just at sign-in,
// so ANY call on this client can try to set a cookie. Once a ReadableStream
// has opened the headers are gone and the write is silently dropped, which
// costs the user their session. Resolve the user in request scope, before the
// stream — see app/api/chat/route.ts.

import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAuthEnv } from "./env";

// Never share one of these across requests — it caches the session of whoever
// created it, which across requests is somebody else's session.
//
// Null when auth is not configured; callers fall back to the cookie identity.
export async function createClient(): Promise<SupabaseClient | null> {
  const env = supabaseAuthEnv();
  if (!env) return null;

  const store = await cookies();

  return createServerClient(env.url, env.anonKey, {
    cookies: {
      // getAll/setAll, not the get/set/remove triple. @supabase/ssr 0.12 types
      // the latter as a separate, deprecated overload; it misses chunked-cookie
      // edge cases and the library's own docs say getting it wrong produces
      // random logouts rather than an error.
      getAll() {
        return store.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            store.set(name, value, options);
          }
        } catch {
          // Thrown when called from a Server Component, which cannot write
          // headers. Swallowing is correct ONLY because proxy.ts refreshes the
          // session on every matched request and writes the cookies there.
          // Route handlers do reach this path successfully, which is what lets
          // signInAnonymously() persist a brand new session.
        }
      },
      // The `headers` second argument to setAll (Cache-Control: private,
      // no-store and friends) is deliberately not used here: next/headers has
      // no API for setting response headers, and a route handler builds its own
      // Response. proxy.ts applies those headers instead, which is the only
      // place in the request lifecycle that can.
    },
  });
}
