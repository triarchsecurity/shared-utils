import { db } from './db';
import { projectMembers } from './schema';
import { sql } from 'drizzle-orm';

export interface UserContext {
  email: string;
  isStaff: boolean;
  memberships: Array<{ project_key: string; role: 'admin' | 'viewer' | 'staff' }>;
}

/**
 * Returns the current user's access context. Reads project_members rows where
 * lower(email) matches the session email. Staff is determined by the presence
 * of a wildcard row (project_key='*', role='staff') per the v1.14.0 design.
 *
 * On DB error, returns null and lets the caller decide whether to fall back to
 * an env-allowlist. NEVER throws.
 */
export async function getCurrentUserContext(
  session: { user?: { email?: string | null } | null } | null
): Promise<UserContext | null> {
  const email = session?.user?.email ?? null;
  if (!email) return null;

  try {
    const rows = await db
      .select({
        projectKey: projectMembers.projectKey,
        role: projectMembers.role,
      })
      .from(projectMembers)
      .where(sql`lower(${projectMembers.email}) = lower(${email})`);

    const memberships = rows.map((r) => ({
      project_key: r.projectKey,
      role: r.role as 'admin' | 'viewer' | 'staff',
    }));

    const isStaff = memberships.some(
      (m) => m.project_key === '*' && m.role === 'staff'
    );

    return { email, isStaff, memberships };
  } catch (err) {
    console.error('[auth-context] DB lookup failed:', err);
    return null;
  }
}
