/**
 * sanitize-commit.ts
 *
 * Pure sanitization helpers for commit-message-derived content.
 *
 * Two helpers:
 *   sanitizeForSlack  — neutralizes Slack mrkdwn control sequences (mention injection, link deception)
 *   sanitizeForRender — strips Unicode trickery (RTL override, zero-width chars) for safe DOM display
 *
 * Both are pure functions (no I/O, no imports from db/server), idempotent, and side-effect free.
 *
 * Apply sanitizeForSlack before any notifyReleaseApproved / postSlackThreadedReply /
 * postSlackChannelMessage call that includes commit-derived strings (Plan 11-04 wraps call sites).
 *
 * Apply sanitizeForRender before rendering commit content in server components / admin UI.
 *
 * Security context: Pitfall 5 (PITFALLS.md) — commit messages are developer-controlled strings.
 * A rogue <!channel> in a commit message would mention an entire Slack channel. RTL override
 * U+202E can make evil.com render as moc.live in the admin UI.
 */

// ─── Slack mrkdwn control sequences ───────────────────────────────────────────

// Broadcast mentions: <!channel>, <!here>, <!everyone> — and mixed-case variants
const SLACK_BROADCAST = /<!(channel|here|everyone)>/gi;

// User mentions: <@UXXXXXXXX>
const SLACK_USER_MENTION = /<@U[A-Z0-9]+>/gi;

// Channel mentions: <#CXXXXXXXX> or <#CXXXXXXXX|name>
const SLACK_CHANNEL_MENTION = /<#C[A-Z0-9]+(\|[^>]*)?>/gi;

// Usergroup mentions: <!subteam^SXXXXXXXX> or <!subteam^SXXXXXXXX|name>
const SLACK_SUBTEAM = /<!subteam\^S[A-Z0-9]+(\|[^>]*)?>/gi;

// Slack link syntax: <https://url|label> — replace with bare URL, drop deceptive label
const SLACK_LINK = /<(https?:\/\/[^|>\s]+)\|[^>]*>/gi;

/**
 * Strips or neutralizes Slack mrkdwn control sequences from a string.
 *
 * Strategy — neutralize, not silently delete:
 * - Broadcast/user/channel/group mentions: replace leading `<!` / `<@` / `<#` with guillemet
 *   (‹) so the literal text remains readable/auditable in Slack without triggering the mention.
 * - Link syntax <URL|label>: extract the real URL and discard the deceptive label.
 * - All replacements are case-insensitive.
 *
 * Idempotent: sanitizeForSlack(sanitizeForSlack(x)) === sanitizeForSlack(x).
 */
export function sanitizeForSlack(text: string): string {
  return text
    // Must run BEFORE broadcast/mention passes so nested forms are handled correctly.
    .replace(SLACK_LINK, '$1')
    .replace(SLACK_BROADCAST, '‹!$1›')
    .replace(SLACK_USER_MENTION, '‹@user›')
    .replace(SLACK_CHANNEL_MENTION, '‹#channel›')
    .replace(SLACK_SUBTEAM, '‹@group›');
}

// ─── Unicode trickery ─────────────────────────────────────────────────────────

/**
 * Character class covering all dangerous invisible/directional Unicode codepoints.
 * Using unicode escape sequences for auditability (codepoints: u202E, u202D, u200B, u200C, u200D, uFEFF):
 *   ‮  RIGHT-TO-LEFT OVERRIDE  — visually reverses text following it
 *   ‭  LEFT-TO-RIGHT OVERRIDE  — forces LTR direction
 *   ​  ZERO WIDTH SPACE
 *   ‌  ZERO WIDTH NON-JOINER
 *   ‍  ZERO WIDTH JOINER
 *   ﻿  ZERO WIDTH NO-BREAK SPACE / BOM
 */
const ZERO_WIDTH_AND_OVERRIDE = /[‮‭​‌‍﻿]/g;

/**
 * Strips Unicode direction-override and zero-width characters from a string.
 *
 * React auto-escapes HTML entities, so this layer is defense-in-depth against
 * Unicode-based visual deception attacks (e.g., RTL override flipping URL display).
 *
 * Idempotent: sanitizeForRender(sanitizeForRender(x)) === sanitizeForRender(x).
 */
export function sanitizeForRender(text: string): string {
  return text.replace(ZERO_WIDTH_AND_OVERRIDE, '');
}
