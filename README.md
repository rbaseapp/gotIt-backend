# GotIt Backend

Independent Node 24 / TypeScript / Express product service. Core validates Bearer
tokens; GotIt owns learning behavior and persists in `product_gotit` using trusted
`application_id` / `application_user_id`. Core source and historical migrations
remain unchanged.

## Routes and implemented flows

`src/server.ts` constructs the services, `src/app.ts` creates Express and
[src/routes.ts](src/routes.ts) mounts all module routers. The old root-level
`app.ts` is excluded from the build. Public `GET /api/v1` lists **73 product
routes** from [api-catalog.ts](src/shared/http/api-catalog.ts).

| Prefix under /api/v1                      | Behavior                                                                                           |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| /profile, /capabilities                   | Languages, interests, learning preferences and configured capabilities                             |
| /notifications                            | Channel consent, push subscription and delivery capability                                         |
| /captures                                 | Manual/provider preview, sense decisions, atomic save and original replay                          |
| /learning-items, /tags                    | Filtered library, edits, bulk actions, restore, mastery, translations, contexts, examples and tags |
| /word-packs                               | Leveled topic catalog, safe library installation/removal and pack-scoped learning                  |
| /practice                                 | Sessions, private single-use exercises, matching and authoritative scored attempts                 |
| /learning                                 | Smart queue and versioned learning/reward configuration                                            |
| /dashboard, /gamification                 | Progress, daily activity, XP, levels and streaks                                                   |
| /reading                                  | Generated preview, encrypted publication, opened-content persistence and article quizzes           |
| /pronunciation, /learning-items/:id/audio | Transient validated WAV, Google speech recognition and reference audio interfaces                  |
| /private-lessons                          | Five-minute personalized OpenAI Realtime voice lesson sessions                                     |
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
word-pack catalog, lesson evidence, personal courses/homework, add-on cycles, notifications and a private lesson minute wallet. The resulting product schema has **47 tables**. The eight historical
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

OpenAI Realtime powers the optional five-minute private-lesson POC. Configure
`OPENAI_REALTIME_API_KEY` (or reuse `OPENAI_API_KEY`), `OPENAI_REALTIME_MODEL`,
`OPENAI_REALTIME_VOICE`, and `OPENAI_REALTIME_TRANSCRIPTION_MODEL`. The authenticated
`POST /api/v1/private-lessons/realtime-sessions` route selects up to five smart-queue
words, builds a profile-aware lesson prompt, and returns a short-lived browser client
secret. Callers may choose a male or female tutor voice and one of five speaking rates,
from very slow to very fast. The client owns the five-minute timer, offers an on-demand translation
of the latest tutor sentence into the profile's support language, and sends the
returned opening and wrap-up events over the WebRTC data channel. At the time limit it
waits for the recap and warm goodbye to finish playing before disconnecting, with a
bounded fallback timeout. No lesson transcript or learning evidence is persisted in
this POC.
Course planning, per-lesson teaching briefs, homework and post-lesson reports use
`OPENAI_PRIVATE_LESSON_MODEL` (deployment default `gpt-6-sol`) through the Responses
API. The teaching brief supplies a short explanation, examples and practice checks
to the Realtime tutor. `OPENAI_TRANSLATION_MODEL` remains assigned to contextual
translation and other non-lesson tasks.
`POST /api/v1/private-lessons/realtime-sessions` accepts optional
`teachingLanguage: "target" | "support"`. The latter requires a configured support
language distinct from the target and applies to explanations, directions and
feedback, while practice examples and learner answers stay in the target language.
The choice is returned with the lesson, reused by every Realtime turn directive,
and saved with the session and per-language lesson preferences. Existing clients
default to target-language teaching for standard lessons and support-language
teaching for absolute beginners. Apply the teaching-language migration before
starting the new backend.
Open `/demo/private-lesson` on the running backend for the standalone demo UI; it
keeps the supplied Core bearer token in memory only and still enforces authentication
when it creates the short-lived Realtime session.

Child course lessons use the existing Rachel tutor identity (`marin` Realtime voice)
and the matching five female portrait frames in
`../gotIt-front/src/assets/private-lesson/`. Adult lessons retain the selected
Rachel or Mike identity (`marin` or `cedar`) and their matching portrait frames.
No dedicated child tutor portrait set or prerecorded voice asset is present in the
GotIt repositories. A distinct child character requires approved identity, matching
media frames and a voice mapping before it can be exposed; do not infer one from a
filename or switch the portrait independently of the voice.

OpenAI contextual translation uses the Responses API with strict structured output.
Set `OPENAI_API_KEY`, `OPENAI_TRANSLATION_MODEL` (the deployment default is
`gpt-5.4-nano`) and an independent `ENRICHMENT_SIGNING_SECRET` of at least 32
bytes. Reading/story generation uses the same `OPENAI_API_KEY` with
`AI_READING_MODEL`; the deployment default is `gpt-6-luna`. Both workloads use
strict structured output, disable reasoning for these focused requests, and set
`store: false`, so responses are not stored by OpenAI.
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

### AI tutor minute wallet

Core maps the seven Paddle prices to six prepaid tutor subscriptions and one
60-minute one-time purchase. A monthly Tutor 60 subscription grants 60 minutes;
quarterly and yearly versions grant 180 and 720 minutes for their full billing
period. Tutor 3×/Week grants 195, 585 or 2340 minutes respectively. Core exposes
only grants backed by an active subscription or a completed one-time transaction
through authenticated `GET /api/v1/billing/minute-grants`. The product runtime
has no direct access to Core billing tables.

`GET /api/v1/private-lesson-minutes` reports the current balance. A voice session
reserves its selected duration (1, 5, 10, 15 or 20 minutes) atomically across
the grants that expire first. Retries do not reserve twice. A failed session
creation returns its minutes; an opened session retains its reservation even if
it ends early or the report fails. Subscription minutes expire at the end of the
paid term; one-time minutes expire one year after purchase. Grants are reconciled
from Core on each balance or reservation request, including revocation. The
Core catalog migration must run before the product migration and backend release.

### Legacy add-on entitlements

The previous add-on cycle scaffold remains inactive. `ENFORCE_ADDON_ENTITLEMENTS`
continues to control the separate AI add-on gate when enabled; private voice
lessons use the minute wallet above. Its status endpoint remains
`GET /api/v1/addons/status`.

`product_gotit.addon_packages` contains an inactive AI option and inactive monthly
lesson options of 2, 4, 8 and 12. Lesson duration is NULL until approved; an active
lesson package must have a duration. Prices, provider price IDs, checkout and webhook
provisioning are deliberately absent. `addon_cycles` holds an explicitly provisioned
half-open `[starts_at, ends_at)` entitlement window and a snapshot of its approved
lesson limit and duration. Renewal creates a new non-overlapping cycle with zero use;
unused lessons do not carry over. This is an implementation default pending a product
decision, not a billing promise. Concurrent session creation increments `lessons_used`
atomically before the provider request. A failed creation releases its reservation
once. Completed, deleted or abandoned sessions keep their consumed slot. The
`addon_lesson_reservations` table records the lesson ID for idempotent release. No
background job invents a renewal or grants access from a payment event.

Before enabling the gate, product and billing owners must approve prices and provider
products, lesson duration, whether AI is separately billed or bundled, trial access,
the authoritative billing period dates, upgrade/downgrade and cancellation behavior,
carryover or refund rules, and treatment of existing Pro subscriptions. A trusted
billing provisioner must create/revoke cycles from verified payment events and reconcile
renewals; there is no public grant endpoint. The existing AI reading quota (one per
trial, four per UTC month for paid accounts) remains separate and needs a product
decision before activation. The lesson duration in the existing five-minute demo is a
prototype default, not an approved package duration. Keep the flag false until the
catalog, provisioner and migration plan for current subscribers are ready. Enabling
the flag without current grants fails closed with `402 ADDON_REQUIRED`.

## HTTP, deployment and verification

`GET /api/v1/private-lessons?limit=50&courseId=<uuid>` מחזיר עד 50 שיעורים
של הקורס המבוקש בלבד, בסדר מהחדש לישן. הסינון לפי בעלות ומזהה קורס מתבצע במסד
לפני החלת המגבלה; השמטת `courseId` שומרת על רשימת השיעורים הכללית.

### Practice reminders and system messages

`GET/PATCH /api/v1/notifications/preferences` manages four independent, initially
disabled email/push consents and a local reminder hour (0–23). The user's profile
IANA timezone supplies the calendar day. Email opt-in requires a verified address
returned by Core. `GET /api/v1/notifications/config` reports provider availability
and the public VAPID key. Authenticated `POST/DELETE /api/v1/notifications/push-subscriptions`
manage browser endpoints. The Web settings page registers a service worker only
when the user enables push.

The web process checks every minute. It queues one reminder per local day and channel
when a review is due and no non-skipped practice attempt exists that day. If the
chosen local hour is skipped by daylight saving time or the service was down at
that hour, it sends at the next run later that day. The database uniqueness key
prevents repeated local hours from queuing duplicates. Internal callers can enqueue
a system message with a stable event key through `NotificationService.queueSystem`;
no automatic system event producer is currently connected.

SMTP and standards-based Web Push are optional transport adapters. Configure
`NOTIFICATION_SMTP_HOST`, `NOTIFICATION_SMTP_PORT`,
`NOTIFICATION_EMAIL_FROM`, and, when authentication is required,
`NOTIFICATION_SMTP_USER` plus `NOTIFICATION_SMTP_PASSWORD`. Configure
`NOTIFICATION_VAPID_SUBJECT` (a contact URL), `NOTIFICATION_VAPID_PUBLIC_KEY`,
and `NOTIFICATION_VAPID_PRIVATE_KEY` for push. Generate the VAPID pair with the
provider's tooling and keep the private key server-side. No values are bundled.
An unconfigured channel cannot be enabled through the API. The deployment must
apply migration `1790800002000_notifications` with the separate migrator before
starting the new backend; it adds three product tables and requires runtime table
grants. The web app and backend need HTTPS for browser push.

Delivery rows are claimed with a bounded lease. Explicit push rate-limit responses
are retried with exponential delay up to five attempts. A timeout, partial push batch or
expired lease is marked `uncertain` and is not automatically retried, preventing
an ambiguous send from being duplicated. Failed and uncertain rows require
operator inspection; no real provider acceptance is claimed by local tests.

Cross-origin browser clients require exact `CORS_ORIGINS` for the Web site and Chrome
extension. Same-origin requests, including the backend-hosted private-lesson demo, are
accepted automatically.
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
together, followed by a new deployment. OpenAI reading generation uses the same
key with `AI_READING_MODEL=gpt-6-luna`. Web/extension origins, Google Speech API
enablement and live verification, production administrator access, calibrated
level estimation and retention policy still require deployment-specific verification.
