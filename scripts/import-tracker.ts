// Phase 5 — one-time import of the legacy Job-Search-Tracker.xlsx (repo root)
// into the `applications` table. Idempotent by (userId, companyName,
// roleTitle): re-running skips rows already imported.
//
// All 24 rows in the tracker have Status="Not started" and no date
// contacted — none of them have actually been applied to yet. Importing
// them as "applied" would fabricate history and wrongly trigger follow-up
// dates. They land as status "not_started" instead (see lib/applications.ts
// importOutreachRow), just so the tracker doesn't lose the research already
// done (proof-of-work angle, outreach channel) once Postgres becomes the
// source of truth.

import AdmZip from "adm-zip";
import path from "node:path";
import { db } from "@/lib/db";
import { applications } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { getOrCreateSingleUser } from "@/lib/user";
import { importOutreachRow } from "@/lib/applications";

interface TrackerRow {
  company: string;
  roleType: string;
  outreachChannel: string;
  proofOfWork: string;
}

function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  const re = /<si>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    // A shared string can contain multiple <t> runs (rich text); join them.
    const text = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("");
    out.push(decodeXmlEntities(text));
  }
  return out;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function cellColumn(ref: string): string {
  return ref.match(/^[A-Z]+/)?.[0] ?? "";
}

function parseSheetRows(xml: string, sharedStrings: string[]): Map<number, Map<string, string>> {
  const rows = new Map<number, Map<string, string>>();
  const rowRe = /<row r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(xml))) {
    const rowNum = Number(rowMatch[1]);
    const cells = new Map<string, string>();
    const cellRe = /<c r="([A-Z]+\d+)"(?:[^>]*t="([a-z]+)")?[^>]*>(?:<v>([\s\S]*?)<\/v>)?<\/c>/g;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowMatch[2]))) {
      const [, ref, type, rawValue] = cellMatch;
      if (rawValue === undefined) continue;
      const value = type === "s" ? sharedStrings[Number(rawValue)] : rawValue;
      cells.set(cellColumn(ref), value ?? "");
    }
    rows.set(rowNum, cells);
  }
  return rows;
}

function readTrackerRows(xlsxPath: string): TrackerRow[] {
  const zip = new AdmZip(xlsxPath);
  const sharedStrings = parseSharedStrings(zip.readAsText("xl/sharedStrings.xml"));
  const rows = parseSheetRows(zip.readAsText("xl/worksheets/sheet1.xml"), sharedStrings);

  const out: TrackerRow[] = [];
  for (const [rowNum, cells] of rows) {
    if (rowNum === 1) continue; // header
    const company = cells.get("A");
    if (!company) continue; // rows 27-31 are the "how to use" / template notes, column A only, skip via other check below
    if (!cells.get("B") && !cells.get("C")) continue; // guard against stray notes rows
    out.push({
      company,
      roleType: cells.get("B") ?? "",
      outreachChannel: cells.get("C") ?? "",
      proofOfWork: cells.get("D") ?? "",
    });
  }
  return out;
}

async function main() {
  // Scripts run with cwd=jobagent/ (see package.json's `harvest`/`test:*`
  // scripts) — the tracker lives one level up, at the repo root.
  const xlsxPath = path.resolve(process.cwd(), "..", "Job-Search-Tracker.xlsx");
  const rows = readTrackerRows(xlsxPath);
  console.log(`Parsed ${rows.length} rows from ${xlsxPath}`);

  const userId = await getOrCreateSingleUser();

  let imported = 0;
  let skipped = 0;
  for (const row of rows) {
    const [existing] = await db
      .select({ id: applications.id })
      .from(applications)
      .where(
        and(
          eq(applications.userId, userId),
          eq(applications.companyName, row.company),
          eq(applications.roleTitle, row.roleType),
        ),
      )
      .limit(1);
    if (existing) {
      skipped++;
      continue;
    }
    const notes = [row.outreachChannel && `Channel: ${row.outreachChannel}`, row.proofOfWork && `Proof-of-work: ${row.proofOfWork}`]
      .filter(Boolean)
      .join(" | ");
    await importOutreachRow({
      userId,
      companyName: row.company,
      roleTitle: row.roleType || null,
      notes: notes || null,
    });
    imported++;
  }

  console.log(`Imported ${imported} new row(s), skipped ${skipped} already-present row(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
