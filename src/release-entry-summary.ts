import { db } from './db';
import { releaseLogLinks, releaseLogs } from './schema';
import { inArray, sql } from 'drizzle-orm';
import { getProjectPipelineSummaries } from './pipeline-summary';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Per-release entry type counts derived from release_log_links.
 * Counts are by typed links only — external links do NOT increment any counter.
 * total = fixes + features (external excluded).
 * A release absent from the Map has no typed links and belongs to the "Other" filter bucket client-side.
 */
export interface EntryTypeCounts {
  fixes: number;
  features: number;
  other: number;    // always 0 for individual releases — "other" bucket is derived client-side
  total: number;    // fixes + features
}

/**
 * Aggregate "what's coming to prod" summary for a project's customer page.
 * Counts are at the RELEASE level (not link-row level): a release with bug+feature links
 * counts as ONE "fix" (fixes-take-precedence bucketing).
 */
export interface WhatsComingSummary {
  totalEntries: number;    // total dev releases since prod cutoff
  fixes: number;           // releases bucketed as fix (has at least one bug link)
  features: number;        // releases bucketed as feature (no bug link, has at least one feature link)
  other: number;           // releases with no typed links
  hasDelta: boolean;       // false when parity/inverted/no-prod; true when dev-ahead
  oneliner: string | null; // "N entries since prod: A fixes, B features, C other" — null when hasDelta=false
}

// ── Sentinel ──────────────────────────────────────────────────────────────────

/**
 * Sentinel for the external link bucket — exported for Plan 02 client reuse if needed.
 */
export const EXTERNAL_BUCKET = 'other' as const;

// ── Private helpers ───────────────────────────────────────────────────────────

/**
 * Format the "N entries since prod: A fixes, B features, C other" one-liner.
 * Zero-count buckets are omitted from the breakdown.
 * Plural-aware: "1 fix", "2 fixes", "1 feature", "2 features", "1 other", "2 other".
 */
function formatOneliner(total: number, fixes: number, features: number, other: number): string {
  const parts: string[] = [];
  if (fixes > 0) parts.push(`${fixes} fix${fixes !== 1 ? 'es' : ''}`);
  if (features > 0) parts.push(`${features} feature${features !== 1 ? 's' : ''}`);
  if (other > 0) parts.push(`${other} other`);
  return `${total} entr${total !== 1 ? 'ies' : 'y'} since prod: ${parts.join(', ')}`;
}

// ── Exports ───────────────────────────────────────────────────────────────────

/**
 * Returns per-release entry type counts from release_log_links for the given releaseIds.
 *
 * A single Drizzle inArray query fetches all relevant rows (no N+1).
 * External links (linkType='external') do NOT count toward typed buckets.
 * Releases with no typed links are absent from the returned Map — callers treat
 * absence as the "Other" filter bucket.
 *
 * @param projectKey - informational; used for context but query filters by releaseId
 * @param releaseIds - array of release_logs.id values to query
 * @returns Map<releaseId, EntryTypeCounts>
 */
export async function getEntryTypeSummaryForProject(
  _projectKey: string,
  releaseIds: string[],
): Promise<Map<string, EntryTypeCounts>> {
  if (releaseIds.length === 0) {
    return new Map<string, EntryTypeCounts>();
  }

  const rows = await db
    .select({
      releaseId: releaseLogLinks.releaseId,
      linkType: releaseLogLinks.linkType,
    })
    .from(releaseLogLinks)
    .where(inArray(releaseLogLinks.releaseId, releaseIds));

  // Walk rows, build per-release counts
  const countsMap = new Map<string, EntryTypeCounts>();

  for (const row of rows) {
    const linkType = row.linkType as string;
    // external links do NOT count toward typed buckets
    if (linkType === 'external') {
      // Ensure a map entry exists so callers can distinguish "has links but all external"
      if (!countsMap.has(row.releaseId)) {
        countsMap.set(row.releaseId, { fixes: 0, features: 0, other: 0, total: 0 });
      }
      continue;
    }

    if (!countsMap.has(row.releaseId)) {
      countsMap.set(row.releaseId, { fixes: 0, features: 0, other: 0, total: 0 });
    }

    const counts = countsMap.get(row.releaseId)!;

    if (linkType === 'bug') {
      counts.fixes++;
      counts.total++;
    } else if (linkType === 'feature') {
      counts.features++;
      counts.total++;
    }
    // Any other unexpected link types are silently ignored (future-proof)
  }

  return countsMap;
}

/**
 * Returns the aggregate "what's coming to prod" summary for a project.
 *
 * Uses release-as-unit bucketing with fixes-take-precedence:
 *   - A release with at least one bug link → "fix" bucket
 *   - A release with no bug links but at least one feature link → "feature" bucket
 *   - A release with no typed links → "other" bucket
 *
 * Returns hasDelta=false when:
 *   - pipelineState is 'parity' or 'inverted'
 *   - prodDeployedAt is null (no prod deploy yet)
 *   - No dev releases found after prod cutoff
 *
 * @param projectKey - the project to summarize
 * @returns WhatsComingSummary
 */
export async function getWhatsComingToProd(projectKey: string): Promise<WhatsComingSummary> {
  const ZERO: WhatsComingSummary = {
    totalEntries: 0,
    fixes: 0,
    features: 0,
    other: 0,
    hasDelta: false,
    oneliner: null,
  };

  // Fetch pipeline state via Phase 8 helper
  const summaries = await getProjectPipelineSummaries([projectKey]);
  const summary = summaries[0];

  if (!summary) return ZERO;
  if (summary.pipelineState !== 'dev-ahead') return ZERO;
  if (!summary.prodDeployedAt) return ZERO;

  const prodCutoffTs = new Date(summary.prodDeployedAt).getTime();

  // Fetch dev release_logs for this project after the prod cutoff
  // Using db.execute with raw SQL to match Phase 8/9 patterns exactly
  type DevRow = {
    id: string;
    deployed_at: string | Date | null;
    released_at: string | Date;
  };

  const devResult = await db.execute(sql`
    SELECT id, deployed_at, released_at
    FROM release_logs
    WHERE project = ${projectKey} AND env = 'dev'
    ORDER BY COALESCE(deployed_at, released_at) DESC NULLS LAST
  `);

  const devRows = (devResult.rows as DevRow[]).filter((row) => {
    const effectiveTs = row.deployed_at ?? row.released_at;
    if (!effectiveTs) return false;
    const ts = new Date(effectiveTs instanceof Date ? effectiveTs.toISOString() : effectiveTs).getTime();
    return ts > prodCutoffTs;
  });

  if (devRows.length === 0) return ZERO;

  const devReleaseIds = devRows.map((r) => r.id);

  // Get entry type counts for these dev releases (one batch query)
  const entryCountsMap = await getEntryTypeSummaryForProject(projectKey, devReleaseIds);

  // Apply release-as-unit bucketing: fixes-take-precedence
  let fixes = 0;
  let features = 0;
  let other = 0;

  for (const releaseId of devReleaseIds) {
    const counts = entryCountsMap.get(releaseId);
    if (!counts || counts.total === 0) {
      // No typed links → other bucket
      other++;
    } else if (counts.fixes > 0) {
      // Has at least one bug link → fix bucket (takes precedence)
      fixes++;
    } else if (counts.features > 0) {
      // No bug links but has feature links → feature bucket
      features++;
    } else {
      // Typed counts exist but none are fix/feature (e.g., all external)
      other++;
    }
  }

  const totalEntries = devRows.length;
  const oneliner = formatOneliner(totalEntries, fixes, features, other);

  return {
    totalEntries,
    fixes,
    features,
    other,
    hasDelta: true,
    oneliner,
  };
}
