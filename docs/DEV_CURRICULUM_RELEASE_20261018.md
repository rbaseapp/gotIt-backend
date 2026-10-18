# DEV curriculum release — 2026-10-18

This branch starts from the exact running DEV revision `7d450427537f816050e3548d2ebba58bd7053932`.
It backports the Admin owner APIs and authored program/material contracts, then adds the curriculum workspace's station settings. It preserves DEV guided activities, course vocabulary, unit prerequisites, and existing learner routes. Production and the unrelated local main checkout are excluded.

The DEV database lacked the Admin foundation. The release applies only the existing forward migrations `1792100000000_admin-operations` and `1792190000000_admin-program-content`, bringing its history from 33 to 35. A protected local full database dump was restored into disposable loopback PostgreSQL and both migrations were rehearsed successfully before applying them to DEV. The actual `gotit_runtime` connection passes schema, DML grants, and strict product-only role checks after migration. No Core migration, permission widening, or learning-data rewrite is required.

Rollback: redeploy `7d450427537f816050e3548d2ebba58bd7053932`; retain the additive schema and authored content. Do not roll back schema after content or prompt snapshots exist.

Validation: 289 fast tests, TypeScript/build, Linux Docker build, and all 104 PostgreSQL cases pass across the full integration run and the corrected focused practice rerun. Integration assertions include the additional DEV activity migration/table; rollback tests explicitly traverse the newer empty Admin migrations. Prompt extraction normalizes source line endings for Windows/Linux consistency. Local Core bootstrap uses the current sibling checkout; the existing CI workflow retains its pinned Core baseline.

Admin has a separate free service `gotit-admin-dev`, targeting DEV Core and Backend. The existing `gotit-admin` service targets production despite its Render project grouping and is untouched. The new DEV origin uses password login; Google login is disabled until its origin is authorized in the existing OAuth client. Existing Core roles and MFA continue to govern reads/writes. Real paid-provider lessons are outside this deployment verification.
