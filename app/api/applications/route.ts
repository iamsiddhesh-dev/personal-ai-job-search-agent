import { getOrCreateUser } from "@/lib/user";
import { listApplications, listDueFollowups, markApplied, bumpSent } from "@/lib/applications";

// GET /api/applications           -> full tracker list (follow-ups auto-advanced)
// GET /api/applications?due=true  -> only rows due for a follow-up right now
export async function GET(req: Request) {
  const userId = await getOrCreateUser();
  const due = new URL(req.url).searchParams.get("due") === "true";
  const rows = due ? await listDueFollowups(userId) : await listApplications(userId);
  return Response.json({ applications: rows });
}

interface MarkAppliedBody {
  jobId?: string;
  companyName?: string;
  roleTitle?: string;
  notes?: string;
}

// POST /api/applications { jobId } — mark a job (from search results) applied.
export async function POST(req: Request) {
  const body = (await req.json()) as MarkAppliedBody;
  if (!body.jobId && !body.companyName) {
    return Response.json({ error: "jobId or companyName is required." }, { status: 400 });
  }
  const userId = await getOrCreateUser();
  const id = await markApplied({
    userId,
    jobId: body.jobId ?? null,
    companyName: body.companyName ?? null,
    roleTitle: body.roleTitle ?? null,
    notes: body.notes ?? null,
  });
  return Response.json({ id });
}

// PATCH /api/applications { id } — user confirms they sent a follow-up on a
// row that surfaced as due; advances its status and computes the next date.
export async function PATCH(req: Request) {
  const body = (await req.json()) as { id?: string };
  if (!body.id) return Response.json({ error: "id is required." }, { status: 400 });
  await bumpSent(body.id);
  return Response.json({ ok: true });
}
