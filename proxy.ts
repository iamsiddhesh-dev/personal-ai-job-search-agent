// Session refresh, on every request that can carry one.
//
// NOTE THE FILENAME. Next 16 renamed the `middleware.ts` convention to
// `proxy.ts` and the exported function from `middleware` to `proxy`
// (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md,
// version history: v16.0.0). Every Supabase SSR guide still says
// `middleware.ts`. That file would be ignored here — no error, no warning, just
// sessions that never refresh and users who get logged out at random.
//
// Why this file has to exist at all: @supabase/ssr rotates the access token on
// its own schedule and writes the new one back as a cookie. A route handler
// that has already opened a ReadableStream cannot set cookies (lib/user.ts:9),
// and a Server Component never can. Proxy runs before either, so it is the one
// place in the request lifecycle where a refresh can always be persisted.

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { supabaseAuthEnv } from "@/lib/supabase/env";

export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request: { headers: request.headers } });

  // Unconfigured is a pass-through, not a crash. This function runs on every
  // matched request, so throwing here would take down every page and every API
  // route the moment it deployed with the env vars unset — for a site that is
  // already live with real users on it.
  const env = supabaseAuthEnv();
  if (!env) return response;

  const supabase = createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        // Write to the REQUEST as well as the response. Without this the route
        // handler downstream reads the stale token out of its own cookies()
        // store and refreshes a second time, racing this one — the rotated
        // refresh token is single-use, so the loser of that race logs the user
        // out.
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request: { headers: request.headers } });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }

        // The second argument is new in @supabase/ssr 0.12 and is the reason
        // this logic cannot live in a route handler: it carries
        // `Cache-Control: private, no-cache, no-store, must-revalidate` and
        // friends. A response that sets a session cookie must never be cached
        // by Vercel's edge, or one visitor is handed another visitor's session
        // token — the same class of cross-tenant leak Phase 0 just closed on
        // /api/drafts, but worse, because it hands over the identity itself.
        for (const [key, value] of Object.entries(headers)) {
          response.headers.set(key, value);
        }
      },
    },
  });

  // This call is the entire point of the file. createServerClient is lazy
  // (skipAutoInitialize), so no session is read — and therefore no refresh
  // happens and no cookie is written — until something asks for the session.
  // getClaims() verifies the JWT rather than trusting the cookie's user object,
  // and calls getSession() underneath, which is what triggers the refresh.
  //
  // The result is deliberately unused: lib/user.ts re-reads the session in
  // request scope, where it also has database access. Proxy only refreshes.
  try {
    await supabase.auth.getClaims();
  } catch (err) {
    // Never let an auth-server hiccup turn into a 500 on every route. A failed
    // refresh means the user falls back to whatever identity lib/user.ts can
    // still resolve, which is the point of the fallback path there.
    console.error("[proxy] session refresh failed:", err);
  }

  return response;
}

export const config = {
  // Deliberately INCLUDES /api. The stock matcher in every Next example
  // excludes it, but /api/chat and /api/run are exactly the routes that stream
  // and so cannot write their own cookies — they are the ones that most need
  // the refresh to have already happened here.
  //
  // Excluded: static assets and the 3D/meme payloads under public/, which carry
  // no session and would only pay the auth round trip for nothing.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|glb|gltf|hdr|mp4|webm|woff2?)$).*)",
  ],
};
