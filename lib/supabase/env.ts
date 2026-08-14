// The two values every Supabase auth client needs, in one place because the
// server client, the browser client and proxy.ts must all agree on them — a
// browser client pointed at a different project than the server client fails
// as "invalid JWT" with nothing explaining why.
//
// This is the PUBLISHABLE key, not the service role key in lib/storage.ts.
// That one is privileged and server-only; this one is designed to sit in the
// browser bundle and is safe there. Do not swap them.
//
// Returns null rather than throwing when it is not configured. Throwing would
// mean proxy.ts — which runs on every matched request — takes the entire site
// down the moment it is deployed with the env vars unset. Unconfigured instead
// degrades to the pre-Phase-A cookie identity in lib/user.ts, which is exactly
// what is running in production today and works.

export type SupabaseAuthEnv = { url: string; anonKey: string };

let warned = false;

export function supabaseAuthEnv(): SupabaseAuthEnv | null {
  // SUPABASE_URL already exists for file storage and points at the same
  // project, so accept either spelling server-side rather than making the owner
  // set the same URL twice. Only the NEXT_PUBLIC_ one is readable in the
  // browser, where the unprefixed one is not inlined and reads as undefined.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    if (!warned) {
      warned = true;
      console.error(
        "[supabase] auth is not configured — NEXT_PUBLIC_SUPABASE_URL and/or " +
          "NEXT_PUBLIC_SUPABASE_ANON_KEY are unset. Falling back to the sh_uid cookie " +
          "identity. See .env.example.",
      );
    }
    return null;
  }

  return { url, anonKey };
}
