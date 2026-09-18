# GotIt Backend

Independent Node 24 / TypeScript / Express product service. Core validates Bearer
tokens; GotIt owns learning behavior and persists in `product_gotit` using trusted
`application_id` / `application_user_id`. Core source and historical migrations
remain unchanged.

## Routes and implemented flows

`src/server.ts` constructs the services, `src/app.ts` creates Express and
[src/routes.ts](src/routes.ts) mounts all module routers. The old root-level
`app.ts` is excluded from the build. Public `GET /api/v1` lists **41 product
routes** from [api-catalog.ts](src/shared/http/api-catalog.ts).

| Prefix under /api/v1                      | Behavior                                                                                           |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| /profile, /capabilities                   | Languages, interests, learning preferences and configured capabilities                             |
| /captures                                 | Manual/provider preview, sense decisions, atomic save and original replay                          |
| /learning-items, /tags                    | Filtered library, edits, bulk actions, restore, mastery, translations, contexts, examples and tags |
| /practice                                 | Sessions, private single-use exercises, matching and authoritative scored attempts                 |
| /learning                                 | Smart queue and versioned learning/reward configuration                                            |
| /dashboard, /gamification                 | Progress, daily activity, XP, levels and streaks                                                   |
| /reading                                  | Generated preview, encrypted publication, opened-content persistence and article quizzes           |
| /pronunciation, /learning-items/:id/audio | Transient validated WAV and speech interfaces; provider unselected                                 |
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

Two GotIt-owned increments in `migrations/` use
`gotit_migrations.pgmigrations` and the shared migration advisory lock. They add
capture/practice/reading receipts, semantic evidence revisions, learning
preferences, `practice_exercises` and `api_rate_limits`. The resulting product
schema has **22 tables**. The eight historical GotIt migrations in Core remain immutable.

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

Default policy requires score 85, three attempts on two calendar days in every
enabled skill and mature review stage. Disabled speech skills never count as
completed. Unique reward ledger keys and a 200-XP daily cap limit repeated rewards;
skips do not change progress, streak or XP. `GET /api/v1/learning/config` exposes
the versioned policy; `LEARNING_POLICY_JSON` supplies validated server overrides.
This initial policy does not implement calibrated automatic CEFR estimation.

## Providers

Vendor adapters and server model profiles are independent of capture. Clients
select `auto`, `dictionary` or `ai`; retryable provider, timeout and response
validation failures receive bounded retries inside one route deadline, then any
explicitly configured fallback is used. Authentication, billing, permission and
invalid-request failures are not retried. Manual capture works without providers.
Capture traces persist bounded metadata for every attempt.

Direct Anthropic translation and reading are implemented. Set
`ANTHROPIC_API_KEY`, optional `ANTHROPIC_WORKSPACE_ID`, `AI_TRANSLATION_MODEL`, optional `AI_READING_MODEL`
(falls back to the translation model) and independent
`ENRICHMENT_SIGNING_SECRET` of at least 32 bytes. No model is silently selected.
The default requests omit model-specific thinking options for translation;
reading with `claude-sonnet-5` explicitly disables thinking. Structured output is opt-in.
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
`SpeechProvider`; additional supported models use server configuration. Speech
remains unconfigured until the user chooses a provider; endpoints return safe
unavailable errors and never fabricate audio or scores.

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
readiness and the current 41-route API catalog. A provider-authenticated smoke
test still requires a valid production session. Claude translation requires
`ANTHROPIC_API_KEY`, `AI_TRANSLATION_MODEL` and `ENRICHMENT_SIGNING_SECRET`
together, followed by a new deployment. Web/extension origins, production
administrator access, selected speech provider, calibrated level estimation and
retention policy still require deployment-specific verification.
