/**
 * @myalterlego/triarch-shared — root barrel.
 *
 * Subpath imports are preferred for tree-shaking:
 *   import { projects } from '@myalterlego/triarch-shared/schema';
 *   import { getCurrentUserContext } from '@myalterlego/triarch-shared/auth';
 *
 * This root barrel re-exports everything for convenience.
 */

export * from './schema';
export * from './auth-context';
export * from './sanitize-commit';
export * from './slack-status';
export * from './db';
export * from './release-entry-summary';
export * from './release-history';
export * from './pipeline-summary';
export * from './group-sections';
export * from './internal-hmac';
