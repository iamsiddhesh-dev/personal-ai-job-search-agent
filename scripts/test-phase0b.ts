import { db } from "@/lib/db";
import { users } from "@/db/schema";
import { uploadResume, getResumeBytes, signedUrl } from "@/lib/storage";
import { eq } from "drizzle-orm";

async function main() {
  // 1. DB round-trip
  const [inserted] = await db.insert(users).values({}).returning();
  console.log("inserted user:", inserted.id);

  const [readBack] = await db.select().from(users).where(eq(users.id, inserted.id));
  if (!readBack || readBack.id !== inserted.id) {
    throw new Error("DB round-trip failed: row not found on read-back");
  }
  console.log("read back user:", readBack.id);

  // 2. Storage round-trip
  const testContent = Buffer.from(`test resume upload ${Date.now()}`);
  const path = await uploadResume(inserted.id, testContent, "txt");
  console.log("uploaded to:", path);

  const downloaded = await getResumeBytes(path);
  if (Buffer.from(downloaded).toString() !== testContent.toString()) {
    throw new Error("Storage round-trip failed: content mismatch");
  }
  console.log("downloaded bytes match upload");

  const url = await signedUrl(path, 60);
  console.log("signed url:", url);

  console.log("\nPHASE 0b EXIT TEST: PASSED");
  process.exit(0);
}

main().catch((e) => {
  console.error("PHASE 0b EXIT TEST: FAILED");
  console.error(e);
  process.exit(1);
});
