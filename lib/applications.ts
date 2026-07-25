// Phase 5 — the tracking loop (REVISED-PLAN.md §8 Phase 5, §10 cadence rules).
//
// Cadence: bump #1 due at day 5-7 after applying, bump #2 due at day 14. A
// due bump SURFACES the row (listDueFollowups) rather than silently changing
// its status — there's no reply-tracking here, so the human has to actually
// look and send the message. `bumpSent()` is what advances the status, called
// when the user acts on a surfaced row. Only the truly passive case — a bump
// #2 window that elapses with nobody ever acting on it, i.e. two silent
// bumps — is auto-marked Dead on read.

import { db } from "@/lib/db";
import { applications, jobs, companies } from "@/db/schema";
import { and, eq, isNotNull, lte } from "drizzle-orm";

export type ApplicationStatus =
  | "not_started" // imported from the xlsx tracker, outreach not yet sent
  | "applied"
  | "followed_up_1"
  | "followed_up_2"
  | "replied"
  | "interview"
  | "offer"
  | "dead";

export interface ApplicationView {
  id: string;
  jobId: string | null;
  title: string;
  company: string;
  applyUrl: string | null;
  status: string;
  appliedAt: Date | null;
  nextFollowupAt: Date | null;
  notes: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const BUMP_1_DAYS = 6; // mid of the "day 5-7" window
const BUMP_2_DAYS = 14;
const DEAD_CHECK_DAYS = 21; // grace period after bump #2 before declaring Dead

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

// Mark a job (or, for manual/imported entries, a bare company+role) as
// applied. Idempotent: re-marking an existing row just refreshes notes rather
// than resetting its follow-up clock.
export async function markApplied(params: {
  userId: string;
  jobId?: string | null;
  companyName?: string | null;
  roleTitle?: string | null;
  appliedAt?: Date;
  status?: ApplicationStatus;
  notes?: string | null;
}): Promise<string> {
  const appliedAt = params.appliedAt ?? new Date();
  const status = params.status ?? "applied";

  let existingId: string | null = null;
  if (params.jobId) {
    const [existing] = await db
      .select({ id: applications.id })
      .from(applications)
      .where(and(eq(applications.userId, params.userId), eq(applications.jobId, params.jobId)))
      .limit(1);
    existingId = existing?.id ?? null;
  }

  if (existingId) {
    if (params.notes) {
      await db.update(applications).set({ notes: params.notes }).where(eq(applications.id, existingId));
    }
    return existingId;
  }

  const [created] = await db
    .insert(applications)
    .values({
      userId: params.userId,
      jobId: params.jobId ?? null,
      companyName: params.companyName ?? null,
      roleTitle: params.roleTitle ?? null,
      status,
      appliedAt,
      nextFollowupAt: status === "applied" ? addDays(appliedAt, BUMP_1_DAYS) : null,
      notes: params.notes ?? null,
    })
    .returning({ id: applications.id });
  return created.id;
}

// Insert a row from the legacy xlsx tracker as-is (status "not_started",
// nothing sent yet) — distinct from markApplied, which always stamps
// appliedAt=now. Used only by scripts/import-tracker.ts.
export async function importOutreachRow(params: {
  userId: string;
  companyName: string;
  roleTitle: string | null;
  notes: string | null;
}): Promise<string> {
  const [created] = await db
    .insert(applications)
    .values({
      userId: params.userId,
      jobId: null,
      companyName: params.companyName,
      roleTitle: params.roleTitle,
      status: "not_started",
      appliedAt: null,
      nextFollowupAt: null,
      notes: params.notes,
    })
    .returning({ id: applications.id });
  return created.id;
}

// Already-applied job ids for a user — fed into MatchOptions.excludeJobIds
// so applied jobs stop surfacing in new searches (REVISED-PLAN §8 Phase 5).
export async function getExcludedJobIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ jobId: applications.jobId })
    .from(applications)
    .where(and(eq(applications.userId, userId), isNotNull(applications.jobId)));
  return rows.map((r) => r.jobId!).filter(Boolean);
}

// Advance the status once the user has actually sent a follow-up on a
// surfaced (due) row. applied -> followed_up_1 (next due: day 14),
// followed_up_1 -> followed_up_2 (next due: the dead-check grace date).
// Calling it again on a followed_up_2 row closes it out as replied.
export async function bumpSent(id: string): Promise<void> {
  const [row] = await db.select().from(applications).where(eq(applications.id, id)).limit(1);
  if (!row) throw new Error(`No application with id ${id}`);
  const appliedAt = row.appliedAt ?? new Date();

  if (row.status === "applied") {
    await db
      .update(applications)
      .set({ status: "followed_up_1", nextFollowupAt: addDays(appliedAt, BUMP_2_DAYS) })
      .where(eq(applications.id, id));
  } else if (row.status === "followed_up_1") {
    await db
      .update(applications)
      .set({ status: "followed_up_2", nextFollowupAt: addDays(appliedAt, DEAD_CHECK_DAYS) })
      .where(eq(applications.id, id));
  } else if (row.status === "followed_up_2") {
    await db.update(applications).set({ status: "replied", nextFollowupAt: null }).where(eq(applications.id, id));
  }
}

// The only automatic status change: a bump #2 window (followed_up_2) that
// elapses with nobody ever sending a third message — two real silent bumps,
// per REVISED-PLAN §10 — gets marked Dead. Rows still at "applied" or
// "followed_up_1" are left alone here; they surface via listDueFollowups
// instead, since a human still needs to act on them.
async function expireDeadRows(userId: string): Promise<void> {
  await db
    .update(applications)
    .set({ status: "dead", nextFollowupAt: null })
    .where(
      and(
        eq(applications.userId, userId),
        eq(applications.status, "followed_up_2"),
        isNotNull(applications.nextFollowupAt),
        lte(applications.nextFollowupAt, new Date()),
      ),
    );
}

async function viewRows(userId: string): Promise<ApplicationView[]> {
  const rows = await db
    .select({
      id: applications.id,
      jobId: applications.jobId,
      companyName: applications.companyName,
      roleTitle: applications.roleTitle,
      status: applications.status,
      appliedAt: applications.appliedAt,
      nextFollowupAt: applications.nextFollowupAt,
      notes: applications.notes,
      jobTitle: jobs.title,
      jobApplyUrl: jobs.applyUrl,
      jobCompany: companies.name,
    })
    .from(applications)
    .leftJoin(jobs, eq(applications.jobId, jobs.id))
    .leftJoin(companies, eq(jobs.companyId, companies.id))
    .where(eq(applications.userId, userId))
    .orderBy(applications.appliedAt);

  return rows.map((r) => ({
    id: r.id,
    jobId: r.jobId,
    title: r.jobTitle ?? r.roleTitle ?? "Unknown role",
    company: r.jobCompany ?? r.companyName ?? "Unknown company",
    applyUrl: r.jobApplyUrl,
    status: r.status,
    appliedAt: r.appliedAt,
    nextFollowupAt: r.nextFollowupAt,
    notes: r.notes,
  }));
}

export async function listApplications(userId: string): Promise<ApplicationView[]> {
  await expireDeadRows(userId);
  return viewRows(userId);
}

// Rows whose follow-up date is today or earlier and are still actionable —
// this is what "resurfaces on its follow-up date" means in the exit test.
export async function listDueFollowups(userId: string): Promise<ApplicationView[]> {
  const all = await listApplications(userId);
  const now = new Date();
  return all.filter(
    (a) =>
      a.nextFollowupAt &&
      a.nextFollowupAt <= now &&
      a.status !== "dead" &&
      a.status !== "offer" &&
      a.status !== "replied" &&
      a.status !== "interview",
  );
}
