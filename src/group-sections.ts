// Inline structural type definitions — kept identical to admin's
// src/app/projects/[slug]/releases/types.ts ReleaseRow/ConflictState/BranchSection
// shapes. Structural typing in TypeScript means admin's types remain
// assignable to these. If admin's shapes change, update both in lockstep.

import type { EntryTypeCounts, WhatsComingSummary } from './release-entry-summary';

export type ReleaseStatus = 'dev' | 'pending_approval' | 'approved' | 'rejected' | 'promoted';
export type ReleaseEnv = 'dev' | 'prod';
export type UserRole = 'admin' | 'viewer';

export interface FeedbackItem {
  id: string;
  releaseId: string;
  authorEmail: string;
  body: string;
  createdAt: string;
}

export interface ApprovalItem {
  id: string;
  releaseId: string;
  approverEmail: string;
  decision: 'approved' | 'rejected';
  approvedAt: string;
  reason: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface ReleaseRow {
  id: string;
  project: string;
  version: string;
  env: ReleaseEnv | null;
  status: ReleaseStatus | null;
  commitSha: string | null;
  deployedAt: string | null;
  releasedAt: string;
  releasedBy: string | null;
  summary: string | null;
  feedback: FeedbackItem[];
  approvals: ApprovalItem[];
  promotionDispatchedAt: string | null;
  promotionDispatchedBy: string | null;
  pairedProd: {
    id: string;
    deployedAt: string | null;
    releasedAt: string;
    releasedBy: string | null;
    commitSha: string | null;
  } | null;
  branch: string | null;
  metadata: Record<string, unknown> | null;
}

export interface ConflictState {
  files: string[];
  rebaseError: string | null;
  createdAt: string;
}

export interface BranchAggregate {
  pending: number;
  promoted: number;
  conflict: boolean;
}

export interface BranchSection {
  branch: string;
  releases: ReleaseRow[];
  conflict: ConflictState | null;
  maxDeployedAt: string | null;
  isActive: boolean;
  aggregate: BranchAggregate;
}

export type { EntryTypeCounts, WhatsComingSummary };

const ACTIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days (D-02)
const ACTIVE_STATUSES: ReadonlySet<string> = new Set(['dev', 'pending_approval', 'approved']);

/**
 * Group releases into branch sections.
 * - Treats null `branch` as 'main' (Phase 3 backfill safety).
 * - Sort: 'main' pinned first, then feature branches by maxDeployedAt desc (D-03).
 * - Conflict is included only when its createdAt is newer than max(release.deployedAt) for that branch (D-16 auto-clear).
 * - Pure: same input → same output. Used both server-side (initial render) and client-side (load-more re-group).
 */
export function groupIntoSections(
  releases: ReleaseRow[],
  conflictsByBranch: Map<string, ConflictState>,
  _projectDeployedUrl: string | null,  // accepted for API symmetry; consumed by resolvePreviewUrl
): BranchSection[] {
  // Group by branch (null → 'main')
  const byBranch = new Map<string, ReleaseRow[]>();
  for (const r of releases) {
    const branch = r.branch ?? 'main';
    const group = byBranch.get(branch) ?? [];
    group.push(r);
    byBranch.set(branch, group);
  }

  const sections: BranchSection[] = Array.from(byBranch.entries()).map(([branch, rows]) => {
    // Compute maxDeployedAt across the section
    let maxDeployedAt: string | null = null;
    for (const r of rows) {
      const at = r.deployedAt ?? r.releasedAt;
      if (!maxDeployedAt || at > maxDeployedAt) maxDeployedAt = at;
    }

    // Conflict auto-clear: include conflict only if its createdAt > maxDeployedAt
    const rawConflict = conflictsByBranch.get(branch) ?? null;
    let conflict: ConflictState | null = null;
    if (rawConflict) {
      if (!maxDeployedAt || rawConflict.createdAt > maxDeployedAt) {
        conflict = rawConflict;
      }
    }

    // isActive (D-02): max deployedAt within 30 days OR latest status non-terminal
    const latestStatus = rows[0]?.status ?? null;
    const ageOk =
      maxDeployedAt !== null &&
      Date.now() - new Date(maxDeployedAt).getTime() < ACTIVE_WINDOW_MS;
    const statusOk = ACTIVE_STATUSES.has(latestStatus ?? '');
    const isActive = ageOk || statusOk;

    // Aggregate counts
    const pending = rows.filter((r) => r.status === 'pending_approval').length;
    const promoted = rows.filter((r) => r.status === 'promoted').length;

    return {
      branch,
      releases: rows,
      conflict,
      maxDeployedAt,
      isActive,
      aggregate: { pending, promoted, conflict: conflict !== null },
    };
  });

  // Sort: main first; then by maxDeployedAt desc (ISO strings sort lexicographically)
  sections.sort((a, b) => {
    if (a.branch === 'main') return -1;
    if (b.branch === 'main') return 1;
    if (!a.maxDeployedAt && !b.maxDeployedAt) return 0;
    if (!a.maxDeployedAt) return 1;
    if (!b.maxDeployedAt) return -1;
    return b.maxDeployedAt.localeCompare(a.maxDeployedAt);
  });

  return sections;
}

/**
 * Resolve the preview / prod URL for a single release row.
 * - main + (env='prod' OR status='promoted') → projects.deployedUrl (D-06)
 * - everything else → metadata.previewUrl (D-06)
 * - missing → null (caller renders disabled icon per D-07)
 */
export function resolvePreviewUrl(
  release: ReleaseRow,
  projectDeployedUrl: string | null,
): string | null {
  const branch = release.branch ?? 'main';
  if (branch === 'main' && (release.env === 'prod' || release.status === 'promoted')) {
    return projectDeployedUrl ?? null;
  }
  const md = release.metadata as { previewUrl?: string } | null;
  return md?.previewUrl ?? null;
}
