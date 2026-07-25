import { db } from "@/lib/db";
import { profiles } from "@/db/schema";
import { eq } from "drizzle-orm";
import { runMatch, type LocationPref, type TeamSizeBucket } from "@/lib/agent/match";
import { buildMatchProfileFromRow } from "@/lib/agent/build-profile";
import { getOrCreateSingleUser } from "@/lib/user";
import { getExcludedJobIds } from "@/lib/applications";

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

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      try {
        const matchProfile = buildMatchProfileFromRow(row);
        send({ type: "status", message: "Building your profile vector…" });
        const userId = await getOrCreateSingleUser();
        const excludeJobIds = await getExcludedJobIds(userId);
        const results = await runMatch(matchProfile, {
          roleFocus,
          locationPref,
          teamSizeBucket,
          excludeJobIds,
          finalLimit: 25,
          log: (m) => send({ type: "status", message: m }),
        });
        send({ type: "result", jobs: results });
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
