import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  bigserial,
  boolean,
  index,
  jsonb,
  vector,
  real,
  unique,
  date,
  primaryKey,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),

  // Supabase Auth uid (auth.users.id), unique. NULL means the row predates auth
  // and is still pinned to an sh_uid cookie — getOrCreateUser() claims those on
  // first sight rather than minting a replacement. Kept as a plain uuid with no
  // .references(): auth.users lives in another schema that Drizzle does not
  // model here, and a real FK would couple our migrations to Supabase's.
  authUserId: uuid("auth_user_id").unique(),

  // Mirrored off the Google identity at sign-in so the UI can render an account
  // menu without a round trip to the auth server on every paint.
  email: text("email"),
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),

  // False only once a real identity is linked. Defaults true because every
  // visitor starts anonymous — that is the whole gate design.
  isAnonymous: boolean("is_anonymous").notNull().default(true),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
});

export const profiles = pgTable("profiles", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  name: text("name"),

  resumePath: text("resume_path"),
  resumeFilename: text("resume_filename"),
  resumeUploadedAt: timestamp("resume_uploaded_at", { withTimezone: true }),
  resumeText: text("resume_text"),
  resumeFacts: jsonb("resume_facts"),

  github: jsonb("github"),
  linkedinText: text("linkedin_text"),
  portfolioUrl: text("portfolio_url"),

  skills: text("skills").array(),
  projects: jsonb("projects"),
  seniority: text("seniority"),
  embedding: vector("embedding", { dimensions: 1024 }), // Voyage voyage-4 (was Gemini 3072)
});

export const companies = pgTable("companies", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  slug: text("slug"),
  website: text("website"),
  source: text("source").notNull(), // 'yc' | 'curated'

  ycBatch: text("yc_batch"),
  teamSize: integer("team_size"),
  industries: text("industries").array(),
  regions: text("regions").array(),

  atsType: text("ats_type"), // 'greenhouse' | 'lever' | 'ashby' | 'workable' | 'recruitee' | null
  atsSlug: text("ats_slug"),
  atsCheckedAt: timestamp("ats_checked_at", { withTimezone: true }),
  atsStatus: text("ats_status"), // 'found' | 'not_found' | 'error'
});

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id),
    source: text("source").notNull(), // 'greenhouse' | 'lever' | 'ashby' | 'workable' | 'recruitee' | 'himalayas'
    externalId: text("external_id").notNull(),

    title: text("title").notNull(),
    description: text("description"),
    location: text("location"),
    isRemote: boolean("is_remote").default(false),
    employmentType: text("employment_type"),
    salaryMin: real("salary_min"),
    salaryMax: real("salary_max"),

    applyUrl: text("apply_url"),
    postedAt: timestamp("posted_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    isActive: boolean("is_active").notNull().default(true),

    embedding: vector("embedding", { dimensions: 1024 }), // Voyage voyage-4 (was Gemini 3072)
    raw: jsonb("raw"),
  },
  (table) => [unique().on(table.source, table.externalId)],
);

export const runs = pgTable("runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  profileId: uuid("profile_id").notNull().references(() => profiles.id),
  roleFocus: text("role_focus"),
  filters: jsonb("filters"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const matches = pgTable("matches", {
  id: uuid("id").primaryKey().defaultRandom(),
  runId: uuid("run_id").notNull().references(() => runs.id),
  jobId: uuid("job_id").notNull().references(() => jobs.id),
  score: real("score"),
  breakdown: jsonb("breakdown"),
  // What to lead outreach with: real experience (job/internship) when the
  // candidate has any relevant to the role, a project only when they don't.
  // See lib/agent/match.ts's leadProof logic.
  leadProof: text("lead_proof"),
  leadProofType: text("lead_proof_type"), // 'experience' | 'project'
  standoutProject: text("standout_project"), // nullable extra project worth mentioning
  gaps: text("gaps").array(),
  rationale: text("rationale"),
});

// Result cache for lib/llm's extractStructured, keyed on (task, hash of the
// exact prompt sent). Free-tier keys can't be multiplied across accounts
// (ToS/ban risk — same-person, same-IP signups are exactly what providers
// watch for), so making a fixed quota go further by never re-paying for
// identical work is the safe lever instead. See lib/llm/cache.ts.
export const llmCache = pgTable(
  "llm_cache",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    task: text("task").notNull(),
    promptHash: text("prompt_hash").notNull(),
    result: jsonb("result").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("llm_cache_task_hash_unique").on(t.task, t.promptHash)],
);

export const applications = pgTable("applications", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  // Nullable: most rows come from a harvested job posting, but the imported
  // xlsx tracker (REVISED-PLAN §8 Phase 5) has manually-tracked outreach
  // targets with no matching row in `jobs` — companyName/roleTitle carry the
  // display info for those instead.
  jobId: uuid("job_id").references(() => jobs.id),
  companyName: text("company_name"),
  roleTitle: text("role_title"),
  status: text("status").notNull().default("applied"),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  nextFollowupAt: timestamp("next_followup_at", { withTimezone: true }),
  notes: text("notes"),
});

// One chat thread. Before Phase B the transcript lived in a useRef on the
// client and was replayed to a stateless /api/chat, so a refresh destroyed it.
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id),
    // The first user message, trimmed. Only for listing threads.
    title: text("title"),

    // The rolling summary, and how far into the thread it reaches. `summary`
    // covers exactly the first `summaryThrough` messages and nothing past them,
    // which is what lets each turn fold only what newly fell out of the raw
    // window instead of re-summarizing the whole history. Get this count wrong
    // and nothing errors — the agent just quietly forgets things.
    summary: text("summary"),
    summaryThrough: integer("summary_through").notNull().default(0),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    // Set by Phase C's "new chat". Archived threads are excluded from listings
    // and hard-deleted by a sweep after 30 days.
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [index("conversations_user_updated_idx").on(t.userId, t.updatedAt.desc())],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),

    // Insertion order, and the only ordering these rows may be read in.
    // conversations.summaryThrough counts from the start of the thread, so it
    // is only meaningful under a total order that cannot tie or shift —
    // created_at can do both when one turn writes a meme and a reply
    // milliseconds apart. Assigned by a sequence; never written by hand.
    ordinal: bigserial("ordinal", { mode: "number" }).notNull(),

    role: text("role").notNull(), // 'user' | 'assistant'
    kind: text("kind").notNull().default("text"), // 'text' | 'jobs' | 'meme'

    // Model-facing text: exactly what historyRef used to hold.
    content: text("content").notNull(),

    // UI-only extras. For a jobs card this is { matchIds }, NOT the hydrated
    // RankedMatch[] — a search returns up to 40 matches and lib/agent/persist.ts
    // already wrote all of it to `matches`, so re-inlining it here would
    // duplicate ~40 KB of jsonb per message. Rehydrated by joining
    // matches -> jobs -> companies (see lib/chat/conversations.ts).
    display: jsonb("display"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("messages_conversation_ordinal_idx").on(t.conversationId, t.ordinal)],
);

// A provider API key a user brought themselves (SCALE-PLAN Phase D.1). Their
// turns then run on their own free-tier quota instead of competing for the
// shared pool, which is the only real fix for a community-sized audience on
// somebody's personal Groq account.
//
// SIGNED-IN ACCOUNTS ONLY, enforced in app/api/keys/route.ts rather than here —
// a column cannot express it, since `is_anonymous` lives on `users`. The reason
// is the still-open question of whether anonymous visitors keep their data at
// all: pinning someone's provider credential to a row that may become
// throwaway is the one version of this that is actively harmful, and requiring
// an account removes it. See SCALE-PLAN's Phase D decisions.
//
// user_id is ON DELETE NO ACTION like every other FK here, so lib/account/
// delete.ts must delete these rows explicitly (it does) and mergeUsers() would
// fail loudly if a key ever needed re-pointing during an anon->Google merge.
// Today it cannot: anonymous rows have no keys, by the rule above.
export const userApiKeys = pgTable(
  "user_api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    // One of lib/llm's ProviderName values. Text rather than an enum to match
    // the rest of this schema, validated at the route.
    provider: text("provider").notNull(),

    // AES-256-GCM, base64, bound to (user_id, provider) as additional
    // authenticated data. NEVER selected into anything that reaches a client —
    // see lib/keys/crypto.ts and lib/keys/store.ts, which is the only module
    // permitted to decrypt it.
    ciphertext: text("ciphertext").notNull(),

    // The last four characters, for "you're using ••••a1b2" in the UI. The only
    // part of the key that may be displayed or logged.
    last4: text("last4").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Refreshed opportunistically, not on every call — enough to tell a live key
    // from an abandoned one without an UPDATE per LLM request.
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  },
  // One key per provider per user: re-submitting replaces rather than
  // accumulating, so there is never an ambiguous "which of their keys".
  (t) => [unique("user_api_keys_user_provider_unique").on(t.userId, t.provider)],
);

// Per-user, per-day action counts (SCALE-PLAN Phase D.2). What stops one
// enthusiastic visitor draining the shared free-tier pool for everyone else.
//
// IN POSTGRES, NOT IN MEMORY, and that is not a style preference: Vercel gives
// every request a fresh serverless isolate, so a module-level Map would count
// to one and reset — a limiter that looks like it works locally and does
// nothing at all in production.
//
// `day` is a DATE in the database's timezone (UTC on Supabase), so quotas reset
// at 00:00 UTC rather than in the user's own timezone. Deliberate: a per-user
// local midnight would need a stored timezone and would let someone reset their
// own quota by changing it.
export const usageCounters = pgTable(
  "usage_counters",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    day: date("day").notNull(),
    action: text("action").notNull(), // 'chat_turn' | 'search'
    count: integer("count").notNull().default(0),
  },
  // Composite primary key, which is also the only way this table is ever read
  // or written. It is what makes the check-and-increment a single atomic
  // INSERT ... ON CONFLICT — see lib/usage/quota.ts for why that matters.
  (t) => [primaryKey({ columns: [t.userId, t.day, t.action] })],
);

export const drafts = pgTable("drafts", {
  id: uuid("id").primaryKey().defaultRandom(),
  matchId: uuid("match_id").notNull().references(() => matches.id),
  kind: text("kind").notNull(), // 'email' | 'linkedin'
  subject: text("subject"),
  body: text("body"),
});
