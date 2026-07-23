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
