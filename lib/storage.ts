import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

const RESUMES_BUCKET = "resumes";

export async function uploadResume(
  userId: string,
  file: Buffer,
  extension: string,
): Promise<string> {
  const path = `${userId}/${randomUUID()}.${extension}`;
  const { error } = await supabase.storage
    .from(RESUMES_BUCKET)
    .upload(path, file, { upsert: false });
  if (error) throw error;
  return path;
}

export async function getResumeBytes(path: string): Promise<Uint8Array> {
  const { data, error } = await supabase.storage
    .from(RESUMES_BUCKET)
    .download(path);
  if (error) throw error;
  return new Uint8Array(await data.arrayBuffer());
}

export async function signedUrl(path: string, ttlSeconds: number): Promise<string> {
  const { data, error } = await supabase.storage
    .from(RESUMES_BUCKET)
    .createSignedUrl(path, ttlSeconds);
  if (error) throw error;
  return data.signedUrl;
}

/**
 * Remove specific objects. Used when a resume is replaced: uploadResume writes a
 * new random path every time and only the newest one is kept in
 * profiles.resumePath, so without this the previous file stays in the bucket
 * forever, referenced by nothing.
 *
 * Deliberately does NOT throw. Both callers have already done the thing that
 * matters — saved the new resume, or deleted the account — and turning a
 * leftover blob into a failed request would undo neither. The count comes back
 * so the caller can log what actually happened.
 */
export async function removeFiles(paths: string[]): Promise<number> {
  if (paths.length === 0) return 0;
  const { data, error } = await supabase.storage.from(RESUMES_BUCKET).remove(paths);
  if (error) {
    console.error("[storage] could not remove objects:", paths, error.message);
    return 0;
  }
  return data?.length ?? 0;
}

// Supabase's list() caps a page at 100 objects regardless of what is asked for.
const LIST_PAGE = 100;

/**
 * Every object under a user's prefix, as full paths.
 *
 * This is what makes "delete my data" cover more than profiles.resumePath: the
 * orphaned blobs described above are unreachable from any table, so listing the
 * prefix is the only way to find them. Paginated because a user who re-uploaded
 * many times before the cleanup above existed can have more than one page.
 */
export async function listUserFiles(userId: string): Promise<string[]> {
  const found: string[] = [];

  for (let offset = 0; ; offset += LIST_PAGE) {
    const { data, error } = await supabase.storage
      .from(RESUMES_BUCKET)
      .list(userId, { limit: LIST_PAGE, offset });
    if (error) throw error;
    if (!data || data.length === 0) break;

    // list() returns names relative to the prefix; remove() wants full paths.
    // It also returns pseudo-directory entries with a null id, which cannot be
    // removed and would make the delete look like it silently failed.
    found.push(...data.filter((o) => o.id).map((o) => `${userId}/${o.name}`));
    if (data.length < LIST_PAGE) break;
  }

  return found;
}
