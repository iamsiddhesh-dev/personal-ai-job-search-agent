import { db } from "@/lib/db";
import { profiles } from "@/db/schema";
import { eq } from "drizzle-orm";
import { runMatch, type LocationPref, type TeamSizeBucket } from "@/lib/agent/match";
import { buildMatchProfileFromRow } from "@/lib/agent/build-profile";
import { getOrCreateUser } from "@/lib/user";
import { getExcludedJobIds } from "@/lib/applications";
import { persistRun } from "@/lib/agent/persist";

interface RunRequest {
  profileId: string;
  roleFocus: string;
  locationPref: LocationPref;
  teamSizeBucket?: TeamSizeBucket;
}

// Streams newline-delimited JSON: {type:"status", message} events while the
// matcher works, then a single {type:"result", jobs} (or {type:"error"}).
// Simplest cut of the Phase-4 streaming UX per REVISED-PLAN.md — status
// events first, cards once the LLM re-rank + link check finish.
export async function POST(req: Request) {
  const body = (await req.json()) as RunRequest;
  const { profileId, roleFocus, locationPref, teamSizeBucket } = body;

  if (!profileId || !roleFocus || !locationPref) {
    return Response.json({ error: "profileId, roleFocus and locationPref are required." }, { status: 400 });
  }

  const [row] = await db.select().from(profiles).where(eq(profiles.id, profileId)).limit(1);
  if (!row) {
    return Response.json({ error: "Profile not found." }, { status: 404 });
  }

  // Resolved here, not inside start(): getOrCreateUser may set the identity
  // cookie, and once the stream begins the response headers are already gone.
  const userId = await getOrCreateUser();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      try {
        const matchProfile = buildMatchProfileFromRow(row);
        send({ type: "status", message: "Building your profile vector…" });
        const excludeJobIds = await getExcludedJobIds(userId);
        const results = await runMatch(matchProfile, {
          roleFocus,
          locationPref,
          teamSizeBucket,
          excludeJobIds,
          log: (m) => send({ type: "status", message: m }),
        });
        // Persist the run + matches so each result carries a matches.id the
        // outreach-drafts step (Phase 6) can reference. A persistence failure
        // must not lose an otherwise-good result set, so fall back to the
        // unpersisted results (drafts just won't be available for that run).
        let jobs = results;
        try {
          jobs = await persistRun({
            userId,
            profileId,
            roleFocus,
            filters: { locationPref, teamSizeBucket: teamSizeBucket ?? "any" },
            results,
          });
        } catch (err) {
          send({ type: "status", message: `(note: couldn't save this run — drafts disabled for it: ${(err as Error).message})` });
        }
        send({ type: "result", jobs });
      } catch (err) {
        send({ type: "error", message: (err as Error).message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" },
  });
}
