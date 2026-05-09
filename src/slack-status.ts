/**
 * Phase 7 OTTOBOT-04 / OTTOBOT-05 — shared status response builder.
 *
 * Used by both:
 *   - POST /api/slack/commands (slash command /triarch status <project>)
 *   - POST /api/slack/events (app_mention `@OttoBot status <project>`)
 *
 * Pattern matches Slack Block Kit section/fields/divider per
 * https://api.slack.com/block-kit. No images, no buttons (D-14).
 *
 * Sections (D-15 in order):
 *   1. Dev — current dev release version + deployed_at humanized
 *   2. Prod — current prod release version + deployed_at humanized
 *   3. Active RCs — branches != 'main' with non-terminal status; cap 5 + "+ N more"
 *   4. Last 3 Deploys — most recent 3 release_logs across all branches/envs
 *
 * Always returns an Array<unknown> compatible with NextResponse.json's `blocks` field.
 */
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { db } from './db';
import { releaseLogs, projects } from './schema';

export interface ProjectStatusData {
  project: typeof projects.$inferSelect;
  devRelease: typeof releaseLogs.$inferSelect | undefined;
  prodRelease: typeof releaseLogs.$inferSelect | undefined;
  activeRCs: (typeof releaseLogs.$inferSelect)[];
  lastDeploys: (typeof releaseLogs.$inferSelect)[];
}

/**
 * Loads project + 4 status sections via 5 Drizzle queries.
 * Returns null when project_key is not found (caller responds with help text).
 */
export async function fetchProjectStatus(projectKey: string): Promise<ProjectStatusData | null> {
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.key, projectKey))
    .limit(1);
  if (!project) return null;

  const [devRelease] = await db
    .select()
    .from(releaseLogs)
    .where(and(eq(releaseLogs.project, projectKey), eq(releaseLogs.env, 'dev')))
    .orderBy(desc(releaseLogs.deployedAt))
    .limit(1);

  const [prodRelease] = await db
    .select()
    .from(releaseLogs)
    .where(and(eq(releaseLogs.project, projectKey), eq(releaseLogs.env, 'prod')))
    .orderBy(desc(releaseLogs.deployedAt))
    .limit(1);

  const activeRCs = await db
    .select()
    .from(releaseLogs)
    .where(and(
      eq(releaseLogs.project, projectKey),
      ne(releaseLogs.branch, 'main'),
      inArray(releaseLogs.status, ['dev', 'pending_approval', 'approved'])
    ))
    .orderBy(desc(releaseLogs.deployedAt))
    .limit(6); // fetch 6, show 5, detect overflow

  const lastDeploys = await db
    .select()
    .from(releaseLogs)
    .where(eq(releaseLogs.project, projectKey))
    .orderBy(desc(sql`COALESCE(${releaseLogs.deployedAt}, ${releaseLogs.releasedAt})`))
    .limit(3);

  return { project, devRelease, prodRelease, activeRCs, lastDeploys };
}

/**
 * Lists project keys for the unknown-project error message (D-16).
 * Default 5; never throws — returns [] on DB failure.
 */
export async function listProjectKeys(limit: number = 5): Promise<string[]> {
  try {
    const rows = await db.select({ key: projects.key }).from(projects).limit(limit);
    return rows.map((r) => r.key);
  } catch {
    return [];
  }
}

/**
 * Humanizes a Date into a short relative-time string.
 * Lightweight and dependency-free per RESEARCH §6.
 */
export function humanizeDate(d: Date | null | undefined): string {
  if (!d) return 'unknown';
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/**
 * Builds the Slack Block Kit array for a status response.
 *
 * Ordering matches D-15:
 *   header → Dev/Prod fields → divider → Active RCs section → divider → Last 3 Deploys
 */
export function buildStatusBlocks(
  projectKey: string,
  devRelease: typeof releaseLogs.$inferSelect | undefined,
  prodRelease: typeof releaseLogs.$inferSelect | undefined,
  activeRCs: (typeof releaseLogs.$inferSelect)[],
  lastDeploys: (typeof releaseLogs.$inferSelect)[]
): unknown[] {
  const blocks: unknown[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${projectKey} — Release Status`, emoji: true },
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*Dev*\n${devRelease ? `${devRelease.version} — ${humanizeDate(devRelease.deployedAt)}` : '_no dev release_'}`,
        },
        {
          type: 'mrkdwn',
          text: `*Prod*\n${prodRelease ? `${prodRelease.version} — ${humanizeDate(prodRelease.deployedAt)}` : '_no prod release_'}`,
        },
      ],
    },
    { type: 'divider' },
  ];

  // Active RCs (cap 5 + overflow indicator)
  const shownRCs = activeRCs.slice(0, 5);
  const overflowCount = Math.max(0, activeRCs.length - 5);
  const rcLines = shownRCs.map(
    (rc) => `• ${rc.branch ?? 'main'} ${rc.version} — ${rc.status}`
  );
  if (overflowCount > 0) rcLines.push(`_+ ${overflowCount} more_`);
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Active RCs*\n${rcLines.length ? rcLines.join('\n') : '_none_'}`,
    },
  });

  blocks.push({ type: 'divider' });

  // Last 3 deploys
  const deployLines = lastDeploys.map((d) => {
    const env = d.env ?? 'unknown';
    const when = humanizeDate(d.deployedAt ?? d.releasedAt);
    return `• ${d.branch ?? 'main'} ${d.version} → ${env} (${when})`;
  });
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*Last 3 Deploys*\n${deployLines.length ? deployLines.join('\n') : '_none_'}`,
    },
  });

  return blocks;
}
