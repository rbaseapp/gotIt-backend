# GotIt Backend

Independent Node 24 / TypeScript / Express product service. Core validates Bearer
tokens; GotIt owns learning behavior and persists in `product_gotit` using trusted
`application_id` / `application_user_id`. Core source and historical migrations
remain unchanged.

## Routes and implemented flows

`src/server.ts` constructs the services, `src/app.ts` creates Express and
[src/routes.ts](src/routes.ts) mounts all module routers. The old root-level
`app.ts` is excluded from the build. Public `GET /api/v1` lists **48 product
routes** from [api-catalog.ts](src/shared/http/api-catalog.ts).

| Prefix under /api/v1                      | Behavior                                                                                           |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| /profile, /capabilities                   | Languages, interests, learning preferences and configured capabilities                             |
| /captures                                 | Manual/provider preview, sense decisions, atomic save and original replay                          |
| /learning-items, /tags                    | Filtered library, edits, bulk actions, restore, mastery, translations, contexts, examples and tags |
| /word-packs                               | Leveled topic catalog, safe library installation/removal and pack-scoped learning                  |
| /practice                                 | Sessions, private single-use exercises, matching and authoritative scored attempts                 |
| /learning                                 | Smart queue and versioned learning/reward configuration                                            |
| /dashboard, /gamification                 | Progress, daily activity, XP, levels and streaks                                                   |
| /reading                                  | Generated preview, encrypted publication, opened-content persistence and article quizzes           |
| /pronunciation, /learning-items/:id/audio | Transient validated WAV, Google speech recognition and reference audio interfaces                  |
| /export, /import                          | Paginated library/progress export and idempotent capture-request import                            |

Product routes authenticate once through Core. `GET /health` checks liveness;
`GET /ready` checks PostgreSQL and fails during draining. Startup separately
checks the current schema and enforces dedicated runtime privileges in production.

Contracts: [capture](../rbaseapp_project_docs_updated/19_GOTIT_B2_CAPTURE_API_CONTRACT.md),
[V1 decisions](../rbaseapp_project_docs_updated/20_GOTIT_V1_IMPLEMENTATION_CONTRACT.md),
[current API and rollout runbook](../rbaseapp_project_docs_updated/21_GOTIT_V1_API_AND_PRODUCTION_RUNBOOK.md).

## Setup and database transition

Install using `npm ci` (`npm.cmd` in PowerShell if execution policy blocks
`npm.ps1`). Copy `.env.example` to ignored `.env` and configure PostgreSQL/Core.
The database must already contain the established 20-table product baseline and
Core foreign-key dependencies. `npm run dev` defaults to port 3001 and refuses
an incomplete V1 schema. Startup never runs migrations implicitly.

GotIt-owned increments in `migrations/` use
`gotit_migrations.pgmigrations` and the shared migration advisory lock. They add
capture/practice/reading receipts, semantic evidence revisions, learning
preferences, `practice_exercises`, `api_rate_limits`, and a versioned topic/level
word-pack catalog. The resulting product schema has **29 tables**. The eight historical
GotIt migrations in Core remain immutable.

For existing databases, first take a backup and review baseline/normalization
and provisioning. `scripts/provision-runtime.sql` and
`scripts/provision-migrator.sql` are one-off administrator templates; assign
passwords separately. Export an explicit `GOTIT_MIGRATION_DATABASE_URL` before
`npm run migrate:up`. The runner neither loads `.env` nor falls back to runtime
`DATABASE_URL`. Down migrations remove V1 data/columns and are tested only on
disposable databases.

`npm run audit:normalization` and `npm run preflight` read only and output safe
counts/codes. Production requires a dedicated product-only runtime role with no
Core access or DDL. Keep migration administrator credentials outside the web service.

## Learning integrity

Clients submit answers, opaque choices or explicit flashcard self-ratings, never
trusted scores/results/XP. Exercises bind scope, session, revision and private
answers. Stale, foreign, expired and consumed exercises cannot score. Scoped UUID
event keys replay original committed receipts after later edits or deletion.

Attempts, effects, skill/item projections, audit transitions, daily activity,
exercise consumption and XP commit in one bounded transaction. Semantic edits
require confirmed translations and reset current evidence/review maturity while
preserving historical attempts, XP, contexts and translation provenance.
Same-sense variants and manual mastery preserve evidence and award no edit XP.

The default policy separates `learned` from `established` retention. A word becomes
learned after three scored attempts overall, including two successful active-recall
answers on two profile-calendar days, recall mastery of at least 80 and a passing
latest answer. Optional skill scores remain visible but do not block learning.
Smart review prioritizes a typed active-recall answer when it can satisfy a missing
learning requirement; after a successful recall that day it resumes the weakest
skill. Optional-skill attempts do not postpone the pending recall review.
Delayed active-recall reviews promote the word to established retention at review
stage four. Unique reward ledger keys limit repeated rewards. XP is awarded at the
full rate through the 200-XP daily threshold and at 25% (rounded to whole XP)
afterward;
skips do not change progress, streak or XP. `GET /api/v1/learning/config` exposes
the versioned policy; `LEARNING_POLICY_JSON` supplies validated server overrides.
This initial policy does not implement calibrated automatic CEFR estimation.

Before a smart-review client issues scored exercises it may request the session's
owned study cards from `GET /api/v1/practice/sessions/:id/study`. This introductory
view exposes the source expression and current primary translation but creates no
attempt, evidence or XP. The separate per-card image route first searches for a
safe reusable photo whose tags match the expression. Context can only break ties
between results that already match the expression. When no relevant stock result
is available, the route may generate a literal low-quality illustration in which
the expression is the primary subject and context only disambiguates its sense.
The selected image is cached on the learning revision. The route returns `null`
when no provider is configured or available.

## Providers

Vendor adapters and server model profiles are independent of capture. Clients
select `auto`, `dictionary` or `ai`; retryable provider, timeout and response
validation failures receive bounded retries inside one route deadline, then any
explicitly configured fallback is used. Authentication, billing, permission and
invalid-request failures are not retried. Manual capture works without providers.
Capture traces persist bounded metadata for every attempt.

Memorization images use Pixabay first when `PIXABAY_API_KEY` is present. Only the
bounded source expression is used as the search query; safe-search is enabled,
search results are cached for 24 hours, and tags must match the expression before
context receives a small tie-breaking weight. Selected media is downloaded and
served by GotIt rather than permanently hotlinked, with provider, creator and
source attribution retained.

The OpenAI Image API is an optional fallback when `OPENAI_API_KEY` is present.
`OPENAI_IMAGE_MODEL` defaults to `gpt-image-2.5-flare`; the deployment config sets
the same value explicitly. The source expression is explicitly the primary visual
subject. The primary translation, language codes and a bounded current context
sentence are treated as untrusted disambiguation data, not additional subjects.
Generation requests use a 90-second deadline, low quality, a valid 1024px square
WebP and automatic moderation. Validated stock or generated results are stored on
`learning_items` for the current `learning_revision`, so later sessions reuse the
image and semantic edits generate a fresh one.

OpenAI contextual translation uses the Responses API with strict structured output.
Set `OPENAI_API_KEY`, `OPENAI_TRANSLATION_MODEL` (the deployment default is
`gpt-5.4-nano`) and an independent `ENRICHMENT_SIGNING_SECRET` of at least 32
bytes. Responses are not stored by OpenAI. Anthropic remains dedicated to
reading/story generation: set `ANTHROPIC_API_KEY`, optional
`ANTHROPIC_WORKSPACE_ID` and `AI_READING_MODEL`. Reading with `claude-sonnet-5`
explicitly disables thinking; `CLAUDE_STRUCTURED_OUTPUT` controls structured
reading output.
Reading receives target expressions with their confirmed meanings; unopened
content is not saved. Missing vocabulary is repaired with a bounded regeneration;
if the model still omits it, exact targets are appended and rebound locally so a
usable passage is returned. Actual quality, access and latency require live evaluation.

Google Cloud Translation Basic v2 is an opt-in adapter. Confirm the enabled API,
then configure `GOOGLE_TRANSLATION_API=cloud_basic_v2` and
`GOOGLE_TRANSLATE_API_KEY`; optional mappings use
`GOOGLE_TRANSLATION_LANGUAGES_JSON`. Requests use plain lexical text and a header
credential. Google does not claim contextual disambiguation, phonetics or an AI
model. No live Google call was made.

Future vendors implement `EnrichmentProvider`, `ReadingGenerator` or
`SpeechProvider`; additional supported models use server configuration. Google
Speech is the deployment default. Set `SPEECH_PROVIDER=google`, enable Cloud
Text-to-Speech and Speech-to-Text, and optionally set `GOOGLE_SPEECH_API_KEY`;
otherwise the existing server-side `GOOGLE_TRANSLATE_API_KEY` is reused for
Text-to-Speech. Speech-to-Text requires Application Default Credentials: provide
service-account JSON in `GOOGLE_SERVICE_ACCOUNT_JSON`, or point
`GOOGLE_APPLICATION_CREDENTIALS` at a server-side secret file. Grant that service
account `roles/speech.client` and `roles/serviceusage.serviceUsageConsumer`.
English and Hebrew have default locale/voice/model mappings, with overrides in
`GOOGLE_SPEECH_LANGUAGES_JSON`. Pronunciation uses a documented composite of
transcript similarity and recognition confidence, not a native phonetic score.
Azure remains an optional adapter for native pronunciation assessment. Without a
configured provider the endpoints return safe unavailable errors and never
fabricate audio or scores.

## Paid feature enforcement

Paid entitlement enforcement is enabled by default. A new account receives the Core-managed 14-day Pro trial; an active subscription keeps all learning capabilities open. After both trial and paid access end, dashboard and saved vocabulary remain readable while capture, library mutations, imports, games, AI reading generation, speech, and pronunciation return `402 SUBSCRIPTION_REQUIRED`. AI reading generation is limited to one successful creation across the entire trial and four per UTC calendar month for paid accounts. AI translation in the browser extension requires a paid account. GotIt never accepts or stores card data.

## HTTP, deployment and verification

Browser clients require exact `CORS_ORIGINS` for the Web site and Chrome extension.
An empty list securely denies cross-origin browser requests while allowing
server-to-server requests without an Origin header.
The backend's Render URL is not their origin. Set `TRUST_PROXY_HOPS` only after
verifying the proxy topology. Shared PostgreSQL limits cover IP, authenticated
users and expensive paths. Private responses use no-store; request IDs correlate
safe errors/logs. Credentials, prompts, tickets and submitted content are omitted.
Pool/query/transaction/provider/HTTP budgets and graceful draining are bounded.

The non-root Node 24 Docker runtime includes migration/preflight tooling.
`render.yaml` prepares manual deployment and /ready without deploying anything.
Startup always runs the read-only schema gate. Optional Render pre-deploy checks
require a verified service plan. CI requires `CORE_PLATFORM_REPOSITORY`, a reviewed
40-character `CORE_PLATFORM_REF` and, for private Core, a read-only checkout token.

```text
npm run format:check
npm run typecheck
npm test
npm run test:integration
npm run build
docker build -t gotit-backend:v1-local .
```

Integration requires Docker and sibling Core historical tooling
(`CORE_PLATFORM_PATH` can override location). Tests bootstrap disposable
PostgreSQL 17 containers, use product-only application roles and stub Core auth,
then dispose containers. They never use `.env` or existing databases.

## Current state — 2026-09-16

Local checks cover scope, concurrency, rollback, original receipts, semantic
history, private exercises, matching, XP cap, publication, safe providers,
import/export and separate runtime/migration roles. Final counts and rollout
steps are recorded in the current runbook.

On 2026-09-16 the production Core authentication boundary was verified and the
Render database was upgraded from the 20-table baseline to the 22-table V1 schema.
A schema-only pre-change dump and SHA-256 were recorded locally. Dedicated
`gotit_migrator` and `gotit_runtime` roles were created with generated credentials;
the migration is repeatable/no-op and strict runtime preflight reports schema,
privileges and product-only role OK. No normalization mismatches or sequence
conflicts were found. The verified Core URL is set in ignored local `.env` and
`render.yaml`. Local baseline data and Core source were not changed.

On 2026-09-16, `https://gotit-backend.onrender.com` returned 200 on health,
readiness and the then-current 41-route API catalog. A provider-authenticated smoke
test still requires a valid production session. OpenAI translation requires
`OPENAI_API_KEY`, `OPENAI_TRANSLATION_MODEL` and `ENRICHMENT_SIGNING_SECRET`
together, followed by a new deployment. Anthropic remains configured only for
story generation through `AI_READING_MODEL`. Web/extension origins, Google Speech API
enablement and live verification, production administrator access, calibrated
level estimation and retention policy still require deployment-specific verification.
