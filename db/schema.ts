import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  vector,
  real,
  unique,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
  embedding: vector("embedding", { dimensions: 3072 }),
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

    embedding: vector("embedding", { dimensions: 3072 }),
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
  leadProject: text("lead_project"),
  gaps: text("gaps").array(),
  rationale: text("rationale"),
});

export const applications = pgTable("applications", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id),
  jobId: uuid("job_id").notNull().references(() => jobs.id),
  status: text("status").notNull().default("applied"),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  nextFollowupAt: timestamp("next_followup_at", { withTimezone: true }),
  notes: text("notes"),
});

export const drafts = pgTable("drafts", {
  id: uuid("id").primaryKey().defaultRandom(),
  matchId: uuid("match_id").notNull().references(() => matches.id),
  kind: text("kind").notNull(), // 'email' | 'linkedin'
  subject: text("subject"),
  body: text("body"),
});
