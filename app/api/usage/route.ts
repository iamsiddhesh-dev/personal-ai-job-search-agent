// Everything the "your usage" panel renders, in one request (SCALE-PLAN Phase
// D). One endpoint rather than three because the panel opens as a unit and
// three round trips would show it assembling itself piece by piece.
//
// Reports only. Nothing here counts a use, stores a key, or changes a thread —
// usageFor() deliberately reads the counters instead of calling consume(), so
// opening the panel can never cost someone a turn.

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/db/schema";
import { getOrCreateUser } from "@/lib/user";
import { keyringFor, listKeys } from "@/lib/keys/store";
import { encryptionAvailable } from "@/lib/keys/crypto";
import { listArchivedConversations, listConversations } from "@/lib/chat/conversations";
import { usageFor } from "@/lib/usage/quota";

export async function GET() {
  const userId = await getOrCreateUser();

  const [account] = await db
    .select({ isAnonymous: users.isAnonymous })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const isAnonymous = account?.isAnonymous ?? true;

  // Decrypted only to answer "are you exempt from this quota", never returned.
  // The masked summaries the client actually renders come from listKeys().
  const caller = await keyringFor(userId);

  const [usage, keys, live, archived] = await Promise.all([
    usageFor(userId, { isAnonymous, caller }),
    listKeys(userId),
    listConversations(userId),
    listArchivedConversations(userId),
  ]);

  return Response.json({
    signedIn: !isAnonymous,
    byokAvailable: encryptionAvailable(),
    usage,
    keys,
    threads: {
      live: live.map((c) => ({
        id: c.id,
        title: c.title,
        updatedAt: c.updatedAt.toISOString(),
      })),
      archived: archived.map((c) => ({
        id: c.id,
        title: c.title,
        updatedAt: c.updatedAt.toISOString(),
        archivedAt: c.archivedAt.toISOString(),
      })),
    },
  });
}
