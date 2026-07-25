// Phase 5 — regenerate a spreadsheet view of the `applications` table
// (REVISED-PLAN.md §2: "Keep an xlsx export so the existing rows survive").
// Postgres is the source of truth now; this file is a disposable, regenerable
// snapshot for anyone who wants to look at the tracker outside the app.
// Writes to Job-Search-Tracker-export.xlsx (repo root) — deliberately NOT
// overwriting the original Job-Search-Tracker.xlsx, which stays as the
// pre-Phase-5 historical artifact.

import fs from "node:fs";
import path from "node:path";
import { getOrCreateSingleUser } from "@/lib/user";
import { listApplications } from "@/lib/applications";
import { buildXlsx } from "@/lib/xlsx-export";

async function main() {
  const userId = await getOrCreateSingleUser();
  const rows = await listApplications(userId);

  const headers = ["Company", "Role", "Status", "Applied at", "Next follow-up", "Apply URL", "Notes"];
  const data = rows.map((r) => [
    r.company,
    r.title,
    r.status,
    r.appliedAt ? r.appliedAt.toISOString().slice(0, 10) : "",
    r.nextFollowupAt ? r.nextFollowupAt.toISOString().slice(0, 10) : "",
    r.applyUrl ?? "",
    r.notes ?? "",
  ]);

  const buf = buildXlsx(headers, data);
  const outPath = path.resolve(process.cwd(), "..", "Job-Search-Tracker-export.xlsx");
  fs.writeFileSync(outPath, buf);
  console.log(`Wrote ${rows.length} row(s) to ${outPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
