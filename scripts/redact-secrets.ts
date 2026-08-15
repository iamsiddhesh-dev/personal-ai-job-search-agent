// Scrub provider API keys that users have pasted into the chat.
//
// This is not hypothetical housekeeping. On 2026-08-15 a real user pasted a
// live Groq key into a conversation, because the agent — before BYOK existed —
// hallucinated the feature and invited them to. The key sat in `messages` in
// plaintext and was replayed to the model providers as conversation history on
// every later turn. lib/chat/agent.ts's system prompt now forbids the agent
// from ever asking for or echoing a key; this cleans up what already landed.
//
// UPDATE, NEVER DELETE. This is the constraint Phase B leaves behind and it is
// easy to get wrong in exactly this situation, where deleting the offending row
// feels like the thorough option: `conversations.summary_through` is a COUNT and
// loadTurnContext reads the unfolded tail with `OFFSET summary_through` over the
// thread's rows. Removing a row from the middle shifts every later one down by
// one, so the agent silently starts reading from the wrong place and nothing
// errors. Replacing the content in place keeps the row count identical.
//
// A redacted key must still be treated as COMPROMISED. It has been in a
// database and sent to third-party inference providers; the only real
// remediation is the user revoking it. This just stops it spreading further.
//
// Run:  npm run redact:secrets           (report only, changes nothing)
//       npm run redact:secrets -- --apply

import { db } from "@/lib/db";
import { sql } from "drizzle-orm";

// Deliberately narrow. Each pattern is a provider's documented key prefix plus
// enough entropy that a false positive is implausible — a broad "long random
// string" rule would redact legitimate message content, which is worse than
// leaving a key that a human has been told to revoke anyway.
const KEY_RX = "(gsk_|sk-[A-Za-z0-9]|csk-|AIza|sk_live_|xoxb-)[A-Za-z0-9_-]{15,}";
const PLACEHOLDER = "[api key removed — revoke it at the provider and add it in Usage & past chats]";

async function main() {
  const apply = process.argv.includes("--apply");

  // Never select or print the key itself. Everything below reports position and
  // ownership only.
  const hits = await db.execute<{
    id: string;
    conversation_id: string;
    role: string;
    user_id: string;
    email: string | null;
    when: string;
  }>(sql`
    SELECT m.id, m.conversation_id, m.role, c.user_id, u.email,
           to_char(m.created_at, 'YYYY-MM-DD HH24:MI') AS when
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    JOIN users u ON u.id = c.user_id
    WHERE m.content ~ ${KEY_RX}
    ORDER BY m.created_at
  `);

  if (hits.length === 0) {
    console.log("no messages contain anything key-shaped.");
    return;
  }

  console.log(`${hits.length} message(s) contain a provider key:\n`);
  for (const h of hits) {
    console.log(`  ${h.when}  ${h.role.padEnd(9)} conversation ${h.conversation_id.slice(0, 8)}  ${h.email ?? h.user_id}`);
  }

  // The other places a transcript gets copied to. Summaries are the dangerous
  // one: a fold would carry the key forward even after the message is scrubbed.
  const summaries = await db.execute<{ id: string }>(sql`
    SELECT id FROM conversations WHERE summary ~ ${KEY_RX}
  `);
  if (summaries.length > 0) {
    console.log(`\n${summaries.length} conversation summary/ies also contain one.`);
  }

  if (!apply) {
    console.log("\nreport only — re-run with --apply to redact.");
    console.log("NOTE: redaction is not remediation. Tell the owner of each key to revoke it.");
    return;
  }

  // regexp_replace with 'g', so a message carrying more than one key loses all
  // of them. The surrounding words the user typed are left alone: the point is
  // to remove the secret, not to erase what they said.
  const redacted = await db.execute<{ id: string }>(sql`
    UPDATE messages
    SET content = regexp_replace(content, ${KEY_RX}, ${PLACEHOLDER}, 'g')
    WHERE content ~ ${KEY_RX}
    RETURNING id
  `);
  const redactedSummaries = await db.execute<{ id: string }>(sql`
    UPDATE conversations
    SET summary = regexp_replace(summary, ${KEY_RX}, ${PLACEHOLDER}, 'g')
    WHERE summary ~ ${KEY_RX}
    RETURNING id
  `);

  const left = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM messages WHERE content ~ ${KEY_RX}
  `);

  console.log(
    `\nredacted ${redacted.length} message(s) and ${redactedSummaries.length} summary/ies; ` +
      `${left[0].n} remaining.`,
  );
  console.log("The keys are still compromised. Their owners must revoke them.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
