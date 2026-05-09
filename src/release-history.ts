import { db } from './db';
import { releaseLogs, releaseLogLinks } from './schema';
import { eq, sql } from 'drizzle-orm';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * A single entry in the release history for a bug or feature.
 * Timestamps are returned as ISO strings (never Date objects) — consumers call
 * formatRelativeTime for display (matches Phase 8 PipelineSummary precedent).
 */
export interface ReleaseHistoryRow {
  releaseLogId: string;
  version: string;
  env: 'dev' | 'prod' | null;
  /** ISO string, or null when both deployed_at and released_at are null (legacy). */
  deployedAt: string | null;
  /** ISO string. release_logs.released_at is NOT NULL so this is always present. */
  releasedAt: string;
  /** The project key (release_logs.project). */
  projectKey: string;
}

// ── Private helpers ──────────────────────────────────────────────────────────

/**
 * Normalize a DB timestamp (string | Date | null | undefined) to an ISO string or null.
 * Mirrors the toIso helper in pipeline-summary.ts — kept local to this file so both
 * files remain self-contained (no shared-utility cross-dependency).
 */
function toIso(val: string | Date | null | undefined): string | null {
  if (val == null) return null;
  if (val instanceof Date) return val.toISOString();
  return val as string;
}

// ── Exports ───────────────────────────────────────────────────────────────────

/**
 * Returns the release history for a bug report, ordered most-recent first.
 *
 * Joins release_log_links → release_logs on releaseId.
 * Filters by release_log_links.bugId = bugId.
 * Ordering: COALESCE(deployed_at, released_at) DESC NULLS LAST — matches the
 * pipeline page ordering convention and handles legacy null deployed_at rows.
 *
 * Returns an empty array when no release_log_links rows exist for the given bugId.
 */
export async function getReleaseHistoryForBug(bugId: string): Promise<ReleaseHistoryRow[]> {
  const rows = await db
    .select({
      releaseLogId: releaseLogs.id,
      version: releaseLogs.version,
      env: releaseLogs.env,
      deployedAt: releaseLogs.deployedAt,
      releasedAt: releaseLogs.releasedAt,
      projectKey: releaseLogs.project,
    })
    .from(releaseLogLinks)
    .innerJoin(releaseLogs, eq(releaseLogLinks.releaseId, releaseLogs.id))
    .where(eq(releaseLogLinks.bugId, bugId))
    .orderBy(sql`COALESCE(${releaseLogs.deployedAt}, ${releaseLogs.releasedAt}) DESC NULLS LAST`);

  return rows.map((row) => ({
    releaseLogId: row.releaseLogId,
    version: row.version,
    env: (row.env ?? null) as 'dev' | 'prod' | null,
    deployedAt: toIso(row.deployedAt),
    releasedAt: toIso(row.releasedAt) ?? new Date(0).toISOString(),
    projectKey: row.projectKey,
  }));
}

/**
 * Returns the release history for a feature request, ordered most-recent first.
 *
 * Identical to getReleaseHistoryForBug but filters by release_log_links.featureId.
 * Kept as two separate functions (not a shared inner function) per pipeline-summary.ts
 * precedent — clearer callsites and simpler test mocking (one mock per function call).
 */
export async function getReleaseHistoryForFeature(featureId: string): Promise<ReleaseHistoryRow[]> {
  const rows = await db
    .select({
      releaseLogId: releaseLogs.id,
      version: releaseLogs.version,
      env: releaseLogs.env,
      deployedAt: releaseLogs.deployedAt,
      releasedAt: releaseLogs.releasedAt,
      projectKey: releaseLogs.project,
    })
    .from(releaseLogLinks)
    .innerJoin(releaseLogs, eq(releaseLogLinks.releaseId, releaseLogs.id))
    .where(eq(releaseLogLinks.featureId, featureId))
    .orderBy(sql`COALESCE(${releaseLogs.deployedAt}, ${releaseLogs.releasedAt}) DESC NULLS LAST`);

  return rows.map((row) => ({
    releaseLogId: row.releaseLogId,
    version: row.version,
    env: (row.env ?? null) as 'dev' | 'prod' | null,
    deployedAt: toIso(row.deployedAt),
    releasedAt: toIso(row.releasedAt) ?? new Date(0).toISOString(),
    projectKey: row.projectKey,
  }));
}
