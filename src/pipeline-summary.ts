import { db } from './db';
import { releaseLogs, projects } from './schema';
import { sql, inArray, eq, and } from 'drizzle-orm';

export type PipelineState = 'parity' | 'dev-ahead' | 'inverted';

export interface WhatChangedSummary {
  totalEntries: number;
  fixes: number;
  features: number;
  other: number;
  oneliner: string; // "N entries since prod: A fixes, B features, C other"
}

export interface PipelineSummary {
  projectKey: string;
  prodVersion: string | null;
  prodDeployedAt: string | null;     // ISO; uses COALESCE(deployed_at, released_at)
  devVersion: string | null;
  devDeployedAt: string | null;      // ISO; uses COALESCE(deployed_at, released_at)
  pendingApprovalCount: number;
  pipelineState: PipelineState;
  whatChangedOneliner: string | null; // null when parity; "dev behind prod" when inverted; full breakdown when dev-ahead
}

// ── New types for getProjectPipelineDetail ───────────────────────────────

export interface RcRow {
  id: string;
  branch: string;
  version: string;
  status: 'dev' | 'pending_approval' | 'approved' | 'rejected' | 'promoted' | null;
  author: string | null;       // releasedBy
  deployedAt: string | null;   // ISO; falls back to releasedAt
  releasedAt: string;          // ISO
  promotionDispatchedAt: string | null;  // for the in-flight UI (plan 09-05)
}

export interface WhatChangedEntry {
  releaseId: string;
  type: 'fix' | 'feature' | 'other';   // bucketed from entry.type
  title: string;                        // entry.message or entry.title
  branch: string;
  author: string | null;
  date: string;                         // ISO
}

export interface DeployHistoryRow {
  id: string;
  env: 'dev' | 'prod';
  version: string;
  deployedAt: string | null;
  releasedAt: string;
  releasedBy: string | null;
}

export interface PipelineDetail {
  project: { key: string; name: string };
  summary: PipelineSummary;          // reuse Phase 8 type
  rcs: RcRow[];                      // sorted: latest deployment first within each branch; branches sorted by max deployedAt desc
  whatChanged: WhatChangedEntry[];   // entries unreleased to prod, in deploy date desc order
  deployHistory: DeployHistoryRow[]; // last 10 prod + last 10 dev, env-tagged, sorted by deployedAt desc
}

// ── Private helpers ──────────────────────────────────────────────────────

/**
 * Bucket a single entry's type string into 'fix' | 'feature' | 'other'.
 */
function bucketEntryTypeSingle(type: string | undefined): 'fix' | 'feature' | 'other' {
  if (type === 'fix' || type === 'bug' || type === 'bugfix') return 'fix';
  if (type === 'feature' || type === 'feat') return 'feature';
  return 'other';
}

/**
 * Bucket entry objects from release_logs.entries[] into fix/feature/other counts.
 * Each entry MAY have a `type` field ('fix'/'bug'/'bugfix'/'feature'/'feat').
 * Absent or unrecognized type → 'other' bucket.
 */
function bucketEntries(entries: unknown): { fixes: number; features: number; other: number } {
  const arr = Array.isArray(entries) ? entries : [];
  let fixes = 0;
  let features = 0;
  let other = 0;
  for (const e of arr) {
    const t = (e as { type?: string })?.type;
    if (t === 'fix' || t === 'bug' || t === 'bugfix') fixes++;
    else if (t === 'feature' || t === 'feat') features++;
    else other++;
  }
  return { fixes, features, other };
}

/**
 * Format the "N entries since prod: A fixes, B features, C other" one-liner.
 * Omits zero-count buckets from the breakdown.
 */
function formatOneliner(b: { fixes: number; features: number; other: number; total: number }): string {
  const parts: string[] = [];
  if (b.fixes > 0) parts.push(`${b.fixes} fix${b.fixes !== 1 ? 'es' : ''}`);
  if (b.features > 0) parts.push(`${b.features} feature${b.features !== 1 ? 's' : ''}`);
  if (b.other > 0) parts.push(`${b.other} other`);
  return `${b.total} entr${b.total !== 1 ? 'ies' : 'y'} since prod: ${parts.join(', ')}`;
}

// ── Main export ──────────────────────────────────────────────────────────

/**
 * Returns per-project pipeline summary data for the admin home tile and
 * per-project pipeline page (Phase 9).
 *
 * Query A: DISTINCT ON (project, env) to get latest dev and prod rows per project.
 *   - Uses raw SQL because Drizzle's typed builder does not natively support DISTINCT ON
 *     (PostgreSQL/CockroachDB-specific extension — see Pitfall 8 in PITFALLS.md).
 *   - WHERE env IN ('dev', 'prod') excludes null-env legacy rows.
 *   - ORDER BY COALESCE(deployed_at, released_at) DESC NULLS LAST handles legacy null deployed_at.
 *
 * Query B: Pending approval count per project (Drizzle typed builder).
 *
 * Query C: All dev rows for the relevant projects (Drizzle typed builder, JS filter by cutoff).
 *   - SAFER ALTERNATIVE to unnest SQL: fetch all dev rows and filter in JavaScript.
 *   - Per-project volume is small (10s of rows), so full fetch + JS filter is correct
 *     and avoids SQL injection risk of dynamic unnest construction.
 */
export async function getProjectPipelineSummaries(
  projectKeys: string[] | null,
): Promise<PipelineSummary[]> {
  // ── Determine which projects to query ──────────────────────────────

  // Query A: DISTINCT ON for latest dev/prod row per project
  // Raw SQL required — Drizzle doesn't support DISTINCT ON natively.
  const projectFilter = projectKeys && projectKeys.length > 0
    ? sql`AND project = ANY(${projectKeys})`
    : sql``;

  const latestResult = await db.execute(sql`
    SELECT DISTINCT ON (project, env)
      project, env, version,
      COALESCE(deployed_at, released_at) AS effective_deployed_at,
      deployed_at, released_at
    FROM release_logs
    WHERE env IN ('dev', 'prod')
    ${projectFilter}
    ORDER BY project, env, COALESCE(deployed_at, released_at) DESC NULLS LAST
  `);

  type LatestRow = {
    project: string;
    env: string;
    version: string;
    effective_deployed_at: string | Date | null;
    deployed_at: string | Date | null;
    released_at: string | Date | null;
  };
  const latestRows = latestResult.rows as LatestRow[];

  // ── Build lookup maps for prod and dev rows ─────────────────────────

  const prodByProject = new Map<string, LatestRow>();
  const devByProject = new Map<string, LatestRow>();

  for (const row of latestRows) {
    if (row.env === 'prod') prodByProject.set(row.project, row);
    else if (row.env === 'dev') devByProject.set(row.project, row);
  }

  // ── Determine target project keys ──────────────────────────────────

  let targetKeys: string[];
  if (projectKeys && projectKeys.length > 0) {
    targetKeys = projectKeys;
  } else {
    // Staff view: all projects in DB
    const allProjects = await db.select({ key: projects.key }).from(projects);
    // Also include any projects found in release_logs that may not be in projects table
    const dbProjectKeys = new Set([...allProjects.map((p) => p.key)]);
    for (const row of latestRows) dbProjectKeys.add(row.project);
    targetKeys = Array.from(dbProjectKeys);
  }

  // ── Query B: Pending approval count per project ─────────────────────

  const pendingRows = await db
    .select({
      project: releaseLogs.project,
      count: sql<number>`count(*)::int`,
    })
    .from(releaseLogs)
    .where(
      projectKeys && projectKeys.length > 0
        ? and(eq(releaseLogs.status, 'pending_approval'), inArray(releaseLogs.project, projectKeys))
        : eq(releaseLogs.status, 'pending_approval'),
    )
    .groupBy(releaseLogs.project);

  const pendingByProject = new Map<string, number>();
  for (const row of pendingRows) {
    pendingByProject.set(row.project, row.count);
  }

  // ── Query C: Dev rows for what-changed calculation ──────────────────
  // SAFER ALTERNATIVE: fetch all dev rows for relevant projects, then
  // filter in JavaScript by per-project prod cutoff timestamp.
  // Dev-row volume per project is small (10s of rows), making this correct
  // and safe — avoids the SQL injection risk of dynamic unnest construction.

  const devRows = await db
    .select({
      project: releaseLogs.project,
      entries: releaseLogs.entries,
      deployedAt: releaseLogs.deployedAt,
      releasedAt: releaseLogs.releasedAt,
    })
    .from(releaseLogs)
    .where(
      projectKeys && projectKeys.length > 0
        ? and(eq(releaseLogs.env, 'dev'), inArray(releaseLogs.project, projectKeys))
        : eq(releaseLogs.env, 'dev'),
    )
    .groupBy(releaseLogs.project, releaseLogs.entries, releaseLogs.deployedAt, releaseLogs.releasedAt);

  // ── Assemble per-project summaries ──────────────────────────────────

  function toIso(val: string | Date | null | undefined): string | null {
    if (val == null) return null;
    if (val instanceof Date) return val.toISOString();
    return val as string;
  }

  return targetKeys.map((key) => {
    const prod = prodByProject.get(key);
    const dev = devByProject.get(key);

    const prodDeployedAt = prod ? toIso(prod.effective_deployed_at) : null;
    const devDeployedAt = dev ? toIso(dev.effective_deployed_at) : null;

    const pendingApprovalCount = pendingByProject.get(key) ?? 0;

    // ── Pipeline state and what-changed one-liner ─────────────────────

    let pipelineState: PipelineState = 'parity';
    let whatChangedOneliner: string | null = null;

    if (prodDeployedAt == null || devDeployedAt == null) {
      // Missing one environment → cannot compare; treat as parity
      pipelineState = 'parity';
      whatChangedOneliner = null;
    } else {
      const prodTs = new Date(prodDeployedAt).getTime();
      const devTs = new Date(devDeployedAt).getTime();
      const prodVersion = prod?.version ?? null;
      const devVersion = dev?.version ?? null;

      if (devTs <= prodTs && prodVersion !== devVersion && prodVersion !== null && devVersion !== null) {
        // Prod has a different (newer) version that dev hasn't caught up to — inverted state.
        // This is the rare post-hotfix case where prod was bumped without going through dev.
        pipelineState = 'inverted';
        whatChangedOneliner = 'dev behind prod';
      } else if (devTs <= prodTs) {
        // Dev is not ahead of prod and versions match (or one is null) → parity.
        // This includes: same version, same timestamp (just promoted), or dev slightly behind.
        pipelineState = 'parity';
        whatChangedOneliner = null;
      } else {
        // Dev is ahead of prod — count entries since prod
        const devRowsSinceProd = devRows.filter((r) => {
          if (r.project !== key) return false;
          const effective = r.deployedAt ?? r.releasedAt;
          if (!effective) return false;
          const ts = new Date(toIso(effective) ?? '').getTime();
          return ts > prodTs;
        });

        if (devRowsSinceProd.length === 0) {
          // Dev timestamp is ahead but no individual rows found since prod — treat as parity
          pipelineState = 'parity';
          whatChangedOneliner = null;
        } else {
          // Aggregate entry buckets across all dev rows since prod
          let totalFixes = 0;
          let totalFeatures = 0;
          let totalOther = 0;
          let totalEntries = 0;

          for (const row of devRowsSinceProd) {
            const bucketed = bucketEntries(row.entries);
            totalFixes += bucketed.fixes;
            totalFeatures += bucketed.features;
            totalOther += bucketed.other;
            totalEntries += bucketed.fixes + bucketed.features + bucketed.other;
          }

          pipelineState = 'dev-ahead';
          whatChangedOneliner = formatOneliner({
            fixes: totalFixes,
            features: totalFeatures,
            other: totalOther,
            total: totalEntries,
          });
        }
      }
    }

    return {
      projectKey: key,
      prodVersion: prod?.version ?? null,
      prodDeployedAt,
      devVersion: dev?.version ?? null,
      devDeployedAt,
      pendingApprovalCount,
      pipelineState,
      whatChangedOneliner,
    };
  });
}

// ── Per-project pipeline detail ──────────────────────────────────────────

/**
 * Returns consolidated pipeline detail for a single project.
 * Returns null if the project does not exist in the projects table (consumers: notFound()).
 *
 * Sections:
 *  - summary:       reuses getProjectPipelineSummaries([slug]) — same Phase 8 shape
 *  - rcs:           all dev-env release_logs for this project, grouped by branch
 *                   sorted by branch maxDeployedAt desc, then by deployedAt desc within branch
 *  - whatChanged:   expanded WhatChangedEntry[] — each entry from dev rows after the prod cutoff
 *                   with type bucketing per bucketEntryTypeSingle()
 *  - deployHistory: last 10 prod + last 10 dev rows from release_logs, sorted desc
 */
export async function getProjectPipelineDetail(slug: string): Promise<PipelineDetail | null> {
  // ── a. Look up project ─────────────────────────────────────────────
  const projectRows = await db
    .select({ key: projects.key, name: projects.name })
    .from(projects)
    .where(eq(projects.key, slug));

  if (projectRows.length === 0) return null;
  const project = projectRows[0];

  // ── b. Get summary via Phase 8 helper ─────────────────────────────
  const summaries = await getProjectPipelineSummaries([slug]);
  const summary = summaries[0] ?? {
    projectKey: slug,
    prodVersion: null,
    prodDeployedAt: null,
    devVersion: null,
    devDeployedAt: null,
    pendingApprovalCount: 0,
    pipelineState: 'parity' as PipelineState,
    whatChangedOneliner: null,
  };

  // ── Helper: normalize DB dates to ISO strings ──────────────────────
  function toIso(val: string | Date | null | undefined): string | null {
    if (val == null) return null;
    if (val instanceof Date) return val.toISOString();
    return val as string;
  }

  // ── c. RC rows (all dev rows for this project) ────────────────────

  type RcRawRow = {
    id: string;
    branch: string | null;
    version: string;
    status: string | null;
    released_by: string | null;
    deployed_at: string | Date | null;
    released_at: string | Date;
    promotion_dispatched_at: string | Date | null;
  };

  const rcResult = await db.execute(sql`
    SELECT id, branch, version, status, released_by,
           deployed_at, released_at, promotion_dispatched_at
    FROM release_logs
    WHERE project = ${slug} AND env = 'dev'
    ORDER BY branch, COALESCE(deployed_at, released_at) DESC NULLS LAST
  `);

  const rawRcRows = rcResult.rows as RcRawRow[];

  // Group by branch, collect RcRow[], then sort branches by their max deployedAt desc
  const branchMap = new Map<string, RcRow[]>();
  for (const row of rawRcRows) {
    const branch = row.branch ?? 'main';
    const rcRow: RcRow = {
      id: row.id,
      branch,
      version: row.version,
      status: (row.status ?? null) as RcRow['status'],
      author: row.released_by ?? null,
      deployedAt: toIso(row.deployed_at),
      releasedAt: toIso(row.released_at) ?? new Date(0).toISOString(),
      promotionDispatchedAt: toIso(row.promotion_dispatched_at),
    };
    if (!branchMap.has(branch)) branchMap.set(branch, []);
    branchMap.get(branch)!.push(rcRow);
  }

  // For each branch compute max deployedAt for sorting
  const branchMaxTs = new Map<string, number>();
  for (const [branch, rows] of branchMap) {
    const max = Math.max(
      ...rows.map((r) => new Date(r.deployedAt ?? r.releasedAt).getTime()),
    );
    branchMaxTs.set(branch, max);
  }

  // Sort within each branch by deployedAt desc (defensive: SQL orders this but mocks may not)
  for (const rows of branchMap.values()) {
    rows.sort((a, b) => {
      const aTs = new Date(a.deployedAt ?? a.releasedAt).getTime();
      const bTs = new Date(b.deployedAt ?? b.releasedAt).getTime();
      return bTs - aTs;
    });
  }

  // Sort branches by max deployedAt desc; within each branch rows are already sorted desc
  const sortedBranches = Array.from(branchMap.keys()).sort(
    (a, b) => (branchMaxTs.get(b) ?? 0) - (branchMaxTs.get(a) ?? 0),
  );

  const rcs: RcRow[] = sortedBranches.flatMap((branch) => branchMap.get(branch)!);

  // ── d. What-changed entries ───────────────────────────────────────
  // Expand dev rows after the prod cutoff into individual WhatChangedEntry[]

  type WhatChangedRawRow = {
    id: string;
    branch: string | null;
    released_by: string | null;
    deployed_at: string | Date | null;
    released_at: string | Date;
    entries: unknown;
  };

  const prodCutoffTs = summary.prodDeployedAt ? new Date(summary.prodDeployedAt).getTime() : null;

  const whatChangedResult = await db.execute(sql`
    SELECT id, branch, released_by, deployed_at, released_at, entries
    FROM release_logs
    WHERE project = ${slug} AND env = 'dev'
    ORDER BY COALESCE(deployed_at, released_at) DESC NULLS LAST
  `);

  const whatChanged: WhatChangedEntry[] = [];
  for (const row of whatChangedResult.rows as WhatChangedRawRow[]) {
    const effectiveTs = toIso(row.deployed_at) ?? toIso(row.released_at);
    if (!effectiveTs) continue;
    // Only include rows after prod cutoff (if prod exists)
    if (prodCutoffTs !== null && new Date(effectiveTs).getTime() <= prodCutoffTs) continue;

    const rowEntries = Array.isArray(row.entries) ? row.entries : [];
    const branch = row.branch ?? 'main';
    const author = row.released_by ?? null;
    const date = effectiveTs;

    for (const entry of rowEntries as { type?: string; message?: string; title?: string }[]) {
      whatChanged.push({
        releaseId: row.id,
        type: bucketEntryTypeSingle(entry.type),
        title: entry.message ?? entry.title ?? '',
        branch,
        author,
        date,
      });
    }
  }

  // ── e. Deploy history: last 10 prod + last 10 dev ─────────────────

  type HistRawRow = {
    id: string;
    env: string;
    version: string;
    deployed_at: string | Date | null;
    released_at: string | Date;
    released_by: string | null;
  };

  const histResult = await db.execute(sql`
    SELECT id, env, version, deployed_at, released_at, released_by
    FROM release_logs
    WHERE project = ${slug} AND env IN ('dev', 'prod')
    ORDER BY COALESCE(deployed_at, released_at) DESC NULLS LAST
  `);

  const allHistRows = histResult.rows as HistRawRow[];

  // Split into prod / dev, take top 10 each, re-merge and sort desc
  const prodHist = allHistRows.filter((r) => r.env === 'prod').slice(0, 10);
  const devHist = allHistRows.filter((r) => r.env === 'dev').slice(0, 10);

  const deployHistory: DeployHistoryRow[] = [...prodHist, ...devHist]
    .map((row) => ({
      id: row.id,
      env: row.env as 'dev' | 'prod',
      version: row.version,
      deployedAt: toIso(row.deployed_at),
      releasedAt: toIso(row.released_at) ?? new Date(0).toISOString(),
      releasedBy: row.released_by ?? null,
    }))
    .sort((a, b) => {
      const aTs = new Date(a.deployedAt ?? a.releasedAt).getTime();
      const bTs = new Date(b.deployedAt ?? b.releasedAt).getTime();
      return bTs - aTs;
    });

  return { project, summary, rcs, whatChanged, deployHistory };
}
