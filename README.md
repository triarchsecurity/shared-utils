# @myalterlego/triarch-shared

Shared Drizzle schema + helpers consumed by `triarch-dev` (admin) and `triarch-portal` (customer) Next.js apps.

Published from `packages/triarch-shared/` inside the `triarch-dev` repo on git tag `shared/v*`.

## Subpath exports

- `@myalterlego/triarch-shared/schema` — Drizzle table definitions + relations
- `@myalterlego/triarch-shared/auth` — `getCurrentUserContext()` membership lookup
- `@myalterlego/triarch-shared/sanitize-commit` — `sanitizeForSlack` / `sanitizeForRender`
- `@myalterlego/triarch-shared/slack` — `fetchProjectStatus` / `buildStatusBlocks` / `humanizeDate` / `listProjectKeys`
- `@myalterlego/triarch-shared/db` — `db` (drizzle pg.Pool wrapper, reads `DATABASE_URL`)

## Migration authority

Admin (`triarch-dev`) is the sole writer of schema migrations. Portal consumes read-only and runs no `db:push`. See `.planning/research/ARCHITECTURE.md` § "Anti-Pattern 3".

## Versioning

Bump `version` field in `packages/triarch-shared/package.json` BEFORE pushing schema changes. CI rejects PRs that touch `src/schema.ts` without a version bump (see `.github/workflows/check-shared-version.yml`).
