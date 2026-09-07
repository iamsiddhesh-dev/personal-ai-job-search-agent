# startHunt

**A conversational job-hunting agent for startup roles.** You talk to it like a
friend who happens to be a great recruiter; it reads your resume and GitHub,
searches a live corpus of startup openings harvested straight from company
applicant-tracking systems, and returns roles ranked on what you have actually
built — with the gaps stated plainly.

🌐 **[starthunt-live.vercel.app](https://starthunt-live.vercel.app)**

Not a job board with a chat box bolted on. Every side effect the agent can cause
— searching, saving a profile, recording an application — goes through a tool
call into audited code. The model chooses *when* to act and how to talk about
it. It never invents results.

---

## The matching pipeline

Four stages. The interesting part is which work happens where, because that
choice is what makes the whole thing affordable on free tiers.

```
profile (resume + GitHub + LinkedIn text)
   │
   ▼
1. RULE FILTER + VECTOR RANK ── one SQL query, in Postgres
      role keywords · location/remote · team size · is_active
      seniority gate · exact cosine over pre-computed pgvector embeddings
   │  ~150 rows out (not 1,500)
   ▼
2. JD GATES ── in JS, because they aren't expressible in SQL
      "N+ years" requirement scan · active-enrollment detection
   │  drops ~37% of the pool
   ▼
3. LLM RE-RANK ── batches of 8, concurrency 2
      true-capability overlap · requirement fit · location feasibility
   │  score 0-100 + leadProof + gaps + rationale per role
   ▼
4. LINK LIVENESS ── HEAD-check every apply URL, drop same-day closures
   │
   ▼
every role scoring ≥70 (not a fixed top-N)
```

**Selection is threshold-based, not top-N.** Everything scoring ≥70 comes back,
however many that is, relaxed once to 60 if the result would be too sparse to be
useful, capped at 40. If the corpus genuinely has three good matches for you, you
get three — padding the list to ten with roles that don't fit is the failure mode
this avoids.

### Stage 1 is one query on purpose

It used to be two stages: a rule filter that pulled up to 1,500 whole job rows
out of Postgres — every `description` and every 1024-dim `embedding` — and then
looped cosine similarity over them in JavaScript.

Measured against the real corpus, one search moved between 0.6 MB and 22.5 MB out
of the database, against a **5 GB/month** free egress allowance. That is a few
hundred searches a month for the entire site.

Ranking where the data already lives sends the vectors nowhere: **8.35 MB → 0.64
MB per search**, measured across 18 real profile/search combinations.

It also fixed a quieter bug. The old query ordered by `posted_at desc` and cut at
1,500 *before* ranking, so on a broad search the vector stage only ever saw the
1,500 freshest matching rows — a better semantic match outside that window was
invisible. Recency was silently overriding fit.

### The index that is deliberately not there

An `hnsw (embedding vector_cosine_ops)` index is the obvious next move and it is
not in the repo, for four measured reasons against the live corpus (15,514 active
embedded rows):

- **It doesn't fix the problem.** The egress win came from not shipping 1,500
  descriptions to the app, not from how Postgres finds the top 150. An index
  changes that number by nothing.
- **Exact ordering isn't slow enough to matter.** `EXPLAIN ANALYZE` puts the full
  scan at ~100 ms server-side, inside a turn whose LLM re-rank alone is ~9 s cold.
  That's roughly 1% of the turn, traded for a recall risk.
- **It cannot be built through this connection string.** `DATABASE_URL` is
  Supabase's transaction pooler, where `SET` doesn't survive to the next
  statement — so the build can't be forced serial, and the parallel one dies on
  the free tier with `could not resize shared memory segment`.
- **It isn't free on disk.** ~65 MB at 1024 dims, against a `jobs` table already
  at 248 MB of a 500 MB database.

If the corpus grows enough that ~100 ms becomes ~1 s, revisit it — with a direct
connection, a serial build, and a recall check against this exact path as the
baseline it has to match.

---

## Where the jobs come from

A harvester walks startup company lists, resolves each company's applicant
tracking system, and pulls openings from the ATS directly — so a posting is a
real live req from the company's own system, not a scraped aggregator listing.

| Company sources | ATS adapters | Also |
|---|---|---|
| Y Combinator · Speedrun · curated accelerators | Greenhouse · Lever · Ashby · Workable · Recruitee | Himalayas (remote) |

Job embeddings are backfilled **offline** by a GitHub Actions workflow every 6
hours, so a live search reads vectors and waits on nothing. The same workflow
carries the project's housekeeping — the 30-day archived-conversation sweep, the
`llm_cache` TTL prune, the usage-counter sweep — because it already runs against
the same database four times a day, and it keeps the Supabase project from
auto-pausing after 7 days idle.

---

## Running an LLM product on free tiers

This is most of the engineering, so it gets stated rather than hidden.

**Every LLM call goes through one choke point** (`lib/llm/`). Callers name a
*task*, never a model. Each task has an ordered chain of provider/model steps,
and each step has a pool of keys:

| Task | Chain |
|---|---|
| `resumeExtraction` | Cerebras → Groq → Gemini |
| `rerank` | Cerebras → Groq → Gemini |
| `hardening` | Groq → Cerebras → Gemini |
| `draftGeneration` | Groq → Cerebras → Gemini |
| chat (tool-calling) | Groq `gpt-oss-120b` → `gpt-oss-20b` → `qwen3.6-27b` → Gemini |
| embeddings | Cohere `embed-v4.0` @ 1024-dim |

Keys are the **inner** loop and models the outer one, which is the whole trick: a
rate limit is per key, so when key #1 is throttled, key #2 on another account
answers immediately — far better than degrading to a weaker model.

**Groq's free-tier token limit is per *model*, not per key and not per family.**
Measured off the `x-ratelimit` headers: spending 2,977 tokens on `gpt-oss-120b`
moved its remaining-tokens down by exactly that, while `gpt-oss-20b` and
`qwen3.6-27b` both moved by 0. Each carries its own 8,000 TPM.

That reframes the app's binding constraint. "8,000 tokens/minute, about one chat
turn per minute for the entire application" is the ceiling of *one model*. Three
of them on the same key and the same account is **24,000 TPM — 3× the chat
capacity, with no new provider, no new account, and nobody's credit card.**

Three more things fall out of the same pressure:

- **A result cache** keyed on `(task, sha256 of the exact prompt)`, with a
  per-task TTL — 6 h for rerank scores, 90 days for resume extraction. Multiplying
  free-tier keys across accounts is exactly what providers ban people for, so
  never re-paying for identical work is the safe lever instead.
- **Bring your own key.** A user can paste their own Groq/Cerebras/Gemini key;
  their turns then run entirely on their quota and stop being counted. Stored
  AES-256-GCM encrypted, bound to `(user_id, provider)` as additional
  authenticated data, with only the last four characters ever displayed. When a
  caller has a key for a provider it is used **exclusively** — no fallback to the
  shared pool, because the heaviest users are precisely the ones who hit their
  own limit, and falling through would put the heaviest load back on the shared
  quota exactly when it is scarcest, invisibly.
- **Per-user daily quotas in Postgres, not in memory.** Vercel gives every request
  a fresh serverless isolate, so a module-level `Map` would count to one and reset
  — a limiter that works locally and does nothing in production. A composite
  primary key makes check-and-increment a single atomic `INSERT … ON CONFLICT`.

Batch sizing is measured too: 15 jobs per re-rank call came to 8,431 tokens and
was rejected outright against Groq's 8,000 TPM — the original production crash.
Eight lands near 3.2k, so two batches can be in flight and still fit.

---

## Two failures worth reading

**A 402 taught the agent to recommend a competitor.** A provider returned
`Payment Required` (a capacity-tier gate, not a real bill). It wasn't in the
retryable-error list, so the chain threw on the first hop instead of walking it;
Stage 3's concurrent map had no per-batch isolation, so one batch's failure killed
the entire search; the exception escaped the `searchJobs` tool uncaught; and the
AI SDK hands an uncaught tool error straight back to the *model* as the tool's
result. With nothing telling it what a raw failure means, the model improvised —
told a real user their search API "spat a payment required error" and then
recommended they go search Wellfound instead. For a product whose entire point is
its own job database, that is close to the worst failure this codebase can have.
Three separate fixes: recognise 402, isolate each batch, and never let an
exception reach the model raw.

**A SQL injection sat behind an apostrophe.** The "local roles" filter pasted the
candidate's own free-text location into a quoted SQL literal. A regex-escape
helper ran over it first, which neutralises regex metacharacters but *not* the
single quote — so a location of `Pune' OR 1=1 --` closed the literal and appended
to the `WHERE` clause of a query against a database holding every user's resume
text and their encrypted provider keys. Now bound as a parameter, along with two
neighbouring constants that were never dangerous themselves, so no safe-looking
template is left for the next person to copy.

Both are documented at the site of the fix, in the code, rather than in a
changelog nobody opens.

---

## The rest of the system

- **Anonymous-first auth.** Every visitor gets a session immediately and can use
  the product before deciding to sign in; a Google sign-in *upgrades* the same
  account rather than replacing it, with a real merge path for rows created
  before the identity existed.
- **Durable conversations with a rolling summary.** Threads persist across
  refreshes. Each turn folds only what newly fell out of the raw context window
  into the summary, tracked by exactly how many messages the summary covers — get
  that count wrong and nothing errors, the agent just quietly forgets things.
  Message order is a `bigserial`, not a timestamp, because `created_at` can tie.
- **An application tracker** with xlsx import/export, follow-up reminders, and
  applied-role exclusion from future searches.
- **A voice that is engineered, not decorated.** The agent talks in lowercase
  Hinglish and roasts the market — "entry level, 5 years experience" is fair game
  — because job hunting grinds people down, and an agent that reads the room gets
  talked to more honestly than one that sounds like a careers portal. It never
  touches the user's worth, intelligence, college, or money, and defeat is
  acknowledged plainly before anything else. The system prompt survived a
  token-diet pass with its examples intact: they are what actually hold the voice.

## Stack

| Layer | Choice |
|---|---|
| App | Next.js 16 (App Router) · React 19 · TypeScript · Tailwind 4 |
| Data | Supabase Postgres + pgvector · Drizzle ORM · Supabase Storage + Auth |
| AI | Vercel AI SDK v7 · Groq · Cerebras · Google Gemini · Cohere embeddings |
| Motion | Framer Motion, plus a hand-built canvas hero |
| Ops | Vercel · GitHub Actions (offline embedding backfill + sweeps) |

## Running it locally

```bash
npm install
cp .env.example .env    # every var is documented inline, including free-tier limits
npm run dev
```

`.env.example` is worth reading on its own — it records the measured free-tier
limit of each provider and which Supabase project settings must be switched on
(neither of which fails loudly when they aren't).

```bash
npm run harvest       # pull companies + jobs from YC/accelerators/ATSes
npm run embed-jobs    # backfill job embeddings (idempotent, resumable)
npm run probe:providers -- groq   # verify a model against the REAL schemas
```

`probe:providers` exists because a toy schema proves nothing: a model that passes
a flat 4-field probe can still score 0/3 on this codebase's actual re-rank schema.
Re-run it before adding any model to a chain.

## Honest limitations

- **"Local" roles only really work for one country.** There is no worldwide city
  dataset here, and inventing one would be worse than admitting the limit — so
  it's an extension point with India filled in. Anything unlisted falls back to
  matching the raw location token, which never shows an onsite role on the wrong
  continent but will miss a neighbouring city.
- **Job freshness is not bounded by default.** A 180-day cap changes a broad
  search's mean cosine by 0.0001, but on *narrow* searches it moves 6–14 of the
  top 24 — a real change to what the matcher returns, so it's a knob rather than a
  default. The costs are measured and recorded: 90 days is −0.6% mean cosine, 30
  days is −5.5%.
- **Ranking quality inherits from one LLM call.** Stage 3 is where every result's
  quality comes from. There is no offline eval set scoring the re-rank against
  labelled ground truth yet, so "it ranks well" is a judgment, not a measurement —
  the honest gap in this repo.
- **Free-tier capacity is the ceiling on everything.** Roughly 1,500 chat turns
  and ~800 searches a day site-wide before the chains start falling back. The
  quotas exist so one enthusiastic visitor can't drain that for everyone else.
