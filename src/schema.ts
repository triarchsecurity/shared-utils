import {
  pgTable,
  uuid,
  varchar,
  integer,
  boolean,
  text,
  jsonb,
  timestamp,
  uniqueIndex,
  index,  // SCHEMA-02: non-unique DESC index for slack_action_audit
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

// ── Control Plane: Projects Registry ──────────────────────────────

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: varchar('key', { length: 64 }).notNull(),
  name: varchar('name', { length: 256 }).notNull(),
  description: text('description'),
  status: varchar('status', { length: 32 }).notNull().default('active'),

  // Infrastructure
  firebaseProjectId: varchar('firebase_project_id', { length: 128 }),
  crdbCluster: varchar('crdb_cluster', { length: 256 }),
  crdbDatabase: varchar('crdb_database', { length: 128 }),
  crdbUser: varchar('crdb_user', { length: 128 }),
  subdomain: varchar('subdomain', { length: 128 }),
  customDomain: varchar('custom_domain', { length: 256 }),
  deployedUrl: varchar('deployed_url', { length: 512 }),

  // Tech details
  githubRepo: varchar('github_repo', { length: 256 }),
  techStack: jsonb('tech_stack').default({}),
  currentVersion: varchar('current_version', { length: 32 }),

  // Grouping
  ecosystem: varchar('ecosystem', { length: 64 }).notNull().default('triarch-dev'),

  // API key for ingest endpoints
  apiKey: varchar('api_key', { length: 128 }),

  // Slack integration — channel for release-approvals notifications (project-scoped)
  slackChannelId: varchar('slack_channel_id', { length: 64 }),

  // ── v2.1 Phase 10: branch preview swap concurrency lock (PREV-01) ──
  previewBranchLocked: text('preview_branch_locked'),                                       // branch name currently being deployed to dev backend; null = no lock
  previewBranchLockedAt: timestamp('preview_branch_locked_at', { withTimezone: true }),     // when the lock was set; route-side 8-min timeout reads this

  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('projects_key_idx').on(table.key),
]);

// ── Plan 4: DB-Driven Navigation ──────────────────────────────────

export const menuSections = pgTable('menu_sections', {
  id: uuid('id').primaryKey().defaultRandom(),
  project: varchar('project', { length: 64 }).notNull(),
  key: varchar('key', { length: 64 }).notNull(),
  label: varchar('label', { length: 128 }).notNull(),
  icon: varchar('icon', { length: 64 }),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  minRole: varchar('min_role', { length: 32 }).notNull().default('user'),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('menu_sections_project_key_idx').on(table.project, table.key),
]);

export const menuPages = pgTable('menu_pages', {
  id: uuid('id').primaryKey().defaultRandom(),
  sectionId: uuid('section_id').notNull().references(() => menuSections.id, { onDelete: 'cascade' }),
  key: varchar('key', { length: 64 }).notNull(),
  label: varchar('label', { length: 128 }).notNull(),
  icon: varchar('icon', { length: 64 }),
  path: varchar('path', { length: 256 }).notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  minRole: varchar('min_role', { length: 32 }).notNull().default('user'),
  badgeSource: varchar('badge_source', { length: 128 }),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('menu_pages_section_key_idx').on(table.sectionId, table.key),
]);

export const menuSubpages = pgTable('menu_subpages', {
  id: uuid('id').primaryKey().defaultRandom(),
  pageId: uuid('page_id').notNull().references(() => menuPages.id, { onDelete: 'cascade' }),
  key: varchar('key', { length: 64 }).notNull(),
  label: varchar('label', { length: 128 }).notNull(),
  path: varchar('path', { length: 256 }).notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  minRole: varchar('min_role', { length: 32 }).notNull().default('user'),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('menu_subpages_page_key_idx').on(table.pageId, table.key),
]);

export const rolePermissions = pgTable('role_permissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  project: varchar('project', { length: 64 }).notNull(),
  role: varchar('role', { length: 32 }).notNull(),
  entityType: varchar('entity_type', { length: 32 }).notNull(),
  entityId: uuid('entity_id').notNull(),
  permission: varchar('permission', { length: 16 }).notNull().default('view'),
  companyId: uuid('company_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('role_permissions_unique_idx').on(
    table.project, table.role, table.entityType, table.entityId, table.companyId
  ),
]);

// ── Module Settings (cross-module config) ─────────────────────────

export const moduleSettings = pgTable('module_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  module: varchar('module', { length: 64 }).notNull(),
  project: varchar('project', { length: 64 }).notNull(),
  scope: varchar('scope', { length: 32 }).notNull(),
  scopeId: varchar('scope_id', { length: 128 }),
  settings: jsonb('settings').notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('module_settings_unique_idx').on(
    table.module, table.project, table.scope, table.scopeId
  ),
]);

// ── Plan 1: Release Audit Logging ─────────────────────────────────

export const releaseLogs = pgTable('release_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  project: varchar('project', { length: 64 }).notNull(),
  version: varchar('version', { length: 32 }).notNull(),
  releaseType: varchar('release_type', { length: 16 }).notNull(),
  releasedAt: timestamp('released_at', { withTimezone: true }).notNull().defaultNow(),
  releasedBy: varchar('released_by', { length: 128 }),
  summary: text('summary'),
  entries: jsonb('entries').notNull().default([]),
  // ── v1.14.0 customer release gating ──
  env: varchar('env', { length: 8 }),                     // 'dev' | 'prod' — nullable for legacy rows; backfill sets 'dev'
  status: varchar('status', { length: 24 }),              // 'dev' | 'pending_approval' | 'approved' | 'rejected' | 'promoted' — nullable for legacy rows; backfill sets 'dev'
  commitSha: varchar('commit_sha', { length: 64 }),       // populated for new CI rows
  deployedAt: timestamp('deployed_at', { withTimezone: true }),  // populated for new CI rows; backfill copies createdAt
  // ── v2.0 Phase 3: multi-branch RC support ──
  branch: varchar('branch', { length: 256 }).default('main'),  // SCHEMA-01: nullable for legacy rows pre-backfill; new rows default to 'main'; non-main values come from shared-workflows once Phase 2 ships
  // ── v1.14.0 Phase 4: GitHub App promotion dispatch audit ──
  promotionDispatchedAt: timestamp('promotion_dispatched_at', { withTimezone: true }),  // populated when /api/slack/interact dispatches deploy-prod.yml
  promotionDispatchedBy: varchar('promotion_dispatched_by', { length: 256 }),           // mapped staff email of the Slack actor who clicked Promote
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('release_logs_project_env_deployed_idx').on(
    table.project,
    table.env,
    table.deployedAt.desc(),
  ),
]);

// ── v1.14.0: Customer Release Gating (membership + audit) ─────────

export const projectMembers = pgTable('project_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectKey: varchar('project_key', { length: 64 }).notNull(),  // '*' = wildcard staff row per CONTEXT.md decisions
  email: varchar('email', { length: 256 }).notNull(),            // stored as-entered; lookups via lower(email)
  role: varchar('role', { length: 16 }).notNull(),               // 'admin' | 'viewer' | 'staff'
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('project_members_unique_idx').on(table.projectKey, sql`lower(${table.email})`),
]);

export const releaseFeedback = pgTable('release_feedback', {
  id: uuid('id').primaryKey().defaultRandom(),
  releaseId: uuid('release_id').notNull().references(() => releaseLogs.id, { onDelete: 'cascade' }),
  authorEmail: varchar('author_email', { length: 256 }).notNull(),
  body: text('body').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const releaseApprovals = pgTable('release_approvals', {
  id: uuid('id').primaryKey().defaultRandom(),
  releaseId: uuid('release_id').notNull().references(() => releaseLogs.id, { onDelete: 'cascade' }),
  approverEmail: varchar('approver_email', { length: 256 }).notNull(),
  decision: varchar('decision', { length: 16 }).notNull(),       // 'approved' | 'rejected' — REJECT-01 lives in same table per Phase 2
  approvedAt: timestamp('approved_at', { withTimezone: true }).notNull().defaultNow(),
  ipAddress: varchar('ip_address', { length: 45 }),
  userAgent: varchar('user_agent', { length: 512 }),
  reason: text('reason'),  // rejection reason for REJECT-01; nullable (approve rows have NULL); 500-char limit enforced server-side
  actorSource: varchar('actor_source', { length: 16 }),  // 'web' | 'slack' — nullable for legacy rows; PROM-04 / Pitfall 4 audit trail unification
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('release_approvals_one_approved_per_release')
    .on(table.releaseId)
    .where(sql`${table.decision} = 'approved'`),
]);

// ── Plan 5: Report Generator ──────────────────────────────────────

export const reportSectionTypes = pgTable('report_section_types', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: varchar('key', { length: 64 }).notNull(),
  name: varchar('name', { length: 128 }).notNull(),
  description: text('description'),
  category: varchar('category', { length: 64 }).notNull(),
  icon: varchar('icon', { length: 64 }),
  dataSchema: jsonb('data_schema').notNull(),
  defaultConfig: jsonb('default_config').default({}),
  requiresServiceOffering: boolean('requires_service_offering').default(false),
  isActive: boolean('is_active').notNull().default(true),
  sortOrder: integer('sort_order').default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('report_section_types_key_idx').on(table.key),
]);

export const reports = pgTable('reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  project: varchar('project', { length: 64 }).notNull(),
  companyId: uuid('company_id'),
  title: varchar('title', { length: 256 }).notNull(),
  reportType: varchar('report_type', { length: 64 }).notNull(),
  status: varchar('status', { length: 32 }).notNull().default('draft'),
  periodStart: timestamp('period_start', { withTimezone: true }),
  periodEnd: timestamp('period_end', { withTimezone: true }),
  sections: jsonb('sections').notNull().default([]),
  metadata: jsonb('metadata').default({}),
  createdBy: varchar('created_by', { length: 128 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Plan 6: Service Offering Builder ──────────────────────────────

export const serviceOfferings = pgTable('service_offerings', {
  id: uuid('id').primaryKey().defaultRandom(),
  key: varchar('key', { length: 64 }).notNull(),
  name: varchar('name', { length: 256 }).notNull(),
  shortDescription: text('short_description'),
  fullDescription: text('full_description'),
  category: varchar('category', { length: 64 }).notNull(),
  status: varchar('status', { length: 32 }).notNull().default('draft'),
  pricingModel: varchar('pricing_model', { length: 32 }).notNull(),
  pricingDetails: jsonb('pricing_details').default({}),
  components: jsonb('components').notNull().default([]),
  milestones: jsonb('milestones').notNull().default([]),
  durationMonths: integer('duration_months'),
  websiteVisible: boolean('website_visible').default(false),
  websiteSortOrder: integer('website_sort_order').default(0),
  websiteFeatures: jsonb('website_features').default([]),
  websiteCtaText: varchar('website_cta_text', { length: 128 }).default('Learn More'),
  websiteCtaUrl: varchar('website_cta_url', { length: 512 }),
  createdBy: varchar('created_by', { length: 128 }),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('service_offerings_key_idx').on(table.key),
]);

export const offeringComponents = pgTable('offering_components', {
  id: uuid('id').primaryKey().defaultRandom(),
  offeringId: uuid('offering_id').notNull().references(() => serviceOfferings.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 256 }).notNull(),
  description: text('description'),
  componentType: varchar('component_type', { length: 32 }).notNull(),
  frequency: varchar('frequency', { length: 32 }),
  quantity: integer('quantity').default(1),
  durationMinutes: integer('duration_minutes'),
  isBillable: boolean('is_billable').default(true),
  sortOrder: integer('sort_order').default(0),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const offeringMilestones = pgTable('offering_milestones', {
  id: uuid('id').primaryKey().defaultRandom(),
  offeringId: uuid('offering_id').notNull().references(() => serviceOfferings.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 256 }).notNull(),
  description: text('description'),
  milestoneType: varchar('milestone_type', { length: 32 }).notNull(),
  monthOffset: integer('month_offset').notNull(),
  revenuePercent: varchar('revenue_percent', { length: 8 }),
  deliverables: jsonb('deliverables').default([]),
  sortOrder: integer('sort_order').default(0),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Plan 3: Bug Fix / Feature Request Portal ─────────────────────

export const bugReports = pgTable('bug_reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  project: varchar('project', { length: 64 }).notNull(),
  reportedByUserId: varchar('reported_by_user_id', { length: 128 }).notNull(),
  reportedByName: varchar('reported_by_name', { length: 256 }),
  reportedByEmail: varchar('reported_by_email', { length: 256 }),
  title: varchar('title', { length: 256 }).notNull(),
  description: text('description').notNull(),
  stepsToReproduce: text('steps_to_reproduce'),
  expectedBehavior: text('expected_behavior'),
  actualBehavior: text('actual_behavior'),
  severity: varchar('severity', { length: 16 }).notNull().default('medium'),
  priority: varchar('priority', { length: 16 }).notNull().default('fix_later'),
  status: varchar('status', { length: 32 }).notNull().default('submitted'),
  screenshotUrls: jsonb('screenshot_urls').default([]),
  pageUrl: varchar('page_url', { length: 512 }),
  browserInfo: jsonb('browser_info').default({}),
  slackMessageTs: varchar('slack_message_ts', { length: 64 }),
  slackChannelId: varchar('slack_channel_id', { length: 64 }),
  fixCommitSha: varchar('fix_commit_sha', { length: 64 }),
  fixVersion: varchar('fix_version', { length: 32 }),
  triarchNotes: text('triarch_notes'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const featureRequests = pgTable('feature_requests', {
  id: uuid('id').primaryKey().defaultRandom(),
  project: varchar('project', { length: 64 }).notNull(),
  requestedByUserId: varchar('requested_by_user_id', { length: 128 }).notNull(),
  requestedByName: varchar('requested_by_name', { length: 256 }),
  requestedByEmail: varchar('requested_by_email', { length: 256 }),
  title: varchar('title', { length: 256 }).notNull(),
  description: text('description').notNull(),
  useCase: text('use_case'),
  priority: varchar('priority', { length: 16 }).default('normal'),
  status: varchar('status', { length: 32 }).notNull().default('submitted'),
  buildPlan: jsonb('build_plan'),
  buildPlanStatus: varchar('build_plan_status', { length: 16 }).default('pending'),
  estimatedEffort: varchar('estimated_effort', { length: 16 }),
  slackMessageTs: varchar('slack_message_ts', { length: 64 }),
  slackChannelId: varchar('slack_channel_id', { length: 64 }),
  targetVersion: varchar('target_version', { length: 32 }),
  shippedVersion: varchar('shipped_version', { length: 32 }),
  triarchNotes: text('triarch_notes'),
  upvotes: integer('upvotes').default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const workflowTransitions = pgTable('workflow_transitions', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityType: varchar('entity_type', { length: 32 }).notNull(),
  entityId: uuid('entity_id').notNull(),
  fromStatus: varchar('from_status', { length: 32 }),
  toStatus: varchar('to_status', { length: 32 }).notNull(),
  transitionedBy: varchar('transitioned_by', { length: 128 }),
  reason: text('reason'),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── Plan 2: Access Logging ────────────────────────────────────────

export const accessAuditLogs = pgTable('access_audit_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  project: varchar('project', { length: 64 }).notNull(),
  actorUserId: varchar('actor_user_id', { length: 128 }).notNull(),
  actorEmail: varchar('actor_email', { length: 256 }),
  targetEntityType: varchar('target_entity_type', { length: 32 }).notNull(),
  targetEntityId: varchar('target_entity_id', { length: 128 }).notNull(),
  targetEntityName: varchar('target_entity_name', { length: 256 }),
  action: varchar('action', { length: 32 }).notNull(),
  reason: text('reason').notNull(),
  sessionId: varchar('session_id', { length: 128 }),
  ipAddress: varchar('ip_address', { length: 45 }),
  metadata: jsonb('metadata').default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// ── v2.0 Phase 3: Slack Action Audit (OttoBot dispatcher) ─────────

export const slackActionAudit = pgTable('slack_action_audit', {
  id: uuid('id').primaryKey().defaultRandom(),
  actionId: varchar('action_id', { length: 128 }).notNull(),                    // SCHEMA-02: free-form Slack action_id (e.g. 'promote_release')
  actorEmail: varchar('actor_email', { length: 256 }),                          // nullable: unmapped Slack users have null email but slack_id is always present
  actorSlackId: varchar('actor_slack_id', { length: 64 }).notNull(),            // raw Slack user_id (Uxxxxx)
  payloadHash: text('payload_hash').notNull(),                                  // sha256 hex of request payload — bounded row size (CONTEXT specifics)
  responseStatus: integer('response_status').notNull(),                         // HTTP status returned to Slack (200, 4xx, 5xx)
  latencyMs: integer('latency_ms').notNull(),                                   // dispatcher latency — always < 3000 (Slack 3-sec rule, CONTEXT specifics)
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('slack_action_audit_created_at_idx').on(table.createdAt.desc()),         // Phase 7 OTTOBOT-06 viewer paginates DESC
]);

// ── v2.0 Phase 4: Promote Attempts (WORKFLOW-04 / WORKFLOW-05) ────

export const promoteAttempts = pgTable('promote_attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  project: varchar('project', { length: 64 }).notNull(),
  branch: varchar('branch', { length: 256 }).notNull(),
  result: varchar('result', { length: 16 }).notNull(),       // 'merged' | 'conflict' | 'ci_failed' — validated in route handler, no CHECK constraint per RESEARCH.md
  mergeSha: varchar('merge_sha', { length: 64 }),            // populated when result='merged'
  conflictFiles: jsonb('conflict_files').default([]),         // populated when result='conflict'
  rebaseError: text('rebase_error'),                          // populated when result='conflict'
  ciRunUrl: text('ci_run_url'),                               // populated when result='ci_failed'
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('promote_attempts_project_branch_idx').on(table.project, table.branch),
  index('promote_attempts_created_at_idx').on(table.createdAt.desc()),
]);

// ── v2.1 Phase 10: Tracker ↔ Release Linkage (LINK-01) ────────────

export const releaseLogLinks = pgTable('release_log_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  releaseId: uuid('release_id').notNull().references(() => releaseLogs.id, { onDelete: 'cascade' }),
  linkType: varchar('link_type', { length: 16 }).notNull(),                          // 'bug' | 'feature' | 'external' — validated via CHECK constraint in migration
  bugId: uuid('bug_id').references(() => bugReports.id, { onDelete: 'cascade' }),     // populated when linkType='bug'; CASCADE so deleting a bug clears its link rows
  featureId: uuid('feature_id').references(() => featureRequests.id, { onDelete: 'cascade' }),  // populated when linkType='feature'
  externalUrl: text('external_url'),                                                  // populated when linkType='external'; freeform URL (GitHub issue, Jira, etc.)
  source: varchar('source', { length: 16 }).notNull(),                                // 'commit' | 'manual' — provenance for Phase 11 auto-stamp vs UI authoring
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('release_log_links_release_id_idx').on(table.releaseId),
  index('release_log_links_bug_id_idx').on(table.bugId),
  index('release_log_links_feature_id_idx').on(table.featureId),
]);

// ── Relations ─────────────────────────────────────────────────────

export const menuSectionsRelations = relations(menuSections, ({ many }) => ({
  pages: many(menuPages),
}));

export const menuPagesRelations = relations(menuPages, ({ one, many }) => ({
  section: one(menuSections, {
    fields: [menuPages.sectionId],
    references: [menuSections.id],
  }),
  subpages: many(menuSubpages),
}));

export const menuSubpagesRelations = relations(menuSubpages, ({ one }) => ({
  page: one(menuPages, {
    fields: [menuSubpages.pageId],
    references: [menuPages.id],
  }),
}));

export const releaseLogsRelations = relations(releaseLogs, ({ many }) => ({
  feedback: many(releaseFeedback),
  approvals: many(releaseApprovals),
  links: many(releaseLogLinks),
}));

export const releaseFeedbackRelations = relations(releaseFeedback, ({ one }) => ({
  release: one(releaseLogs, {
    fields: [releaseFeedback.releaseId],
    references: [releaseLogs.id],
  }),
}));

export const releaseApprovalsRelations = relations(releaseApprovals, ({ one }) => ({
  release: one(releaseLogs, {
    fields: [releaseApprovals.releaseId],
    references: [releaseLogs.id],
  }),
}));

export const releaseLogLinksRelations = relations(releaseLogLinks, ({ one }) => ({
  release: one(releaseLogs, {
    fields: [releaseLogLinks.releaseId],
    references: [releaseLogs.id],
  }),
  bug: one(bugReports, {
    fields: [releaseLogLinks.bugId],
    references: [bugReports.id],
  }),
  feature: one(featureRequests, {
    fields: [releaseLogLinks.featureId],
    references: [featureRequests.id],
  }),
}));
