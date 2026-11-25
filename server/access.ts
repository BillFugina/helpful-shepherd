import { eq } from 'drizzle-orm'
import type { Grants, Role } from '../shared/access.js'
import type { Db } from './db/client.js'
import { roleGrant, userRole } from './db/schema.js'

export interface Access {
  role: Role
  grants: Grants
}

/** The user's role and its grants, or null when the user has no role (sees nothing). */
export async function loadAccess(db: Db, userId: string): Promise<Access | null> {
  const [row] = await db.select({ role: userRole.role }).from(userRole).where(eq(userRole.userId, userId)).limit(1)
  if (!row) return null
  const rows = await db
    .select({ fieldGroup: roleGrant.fieldGroup, level: roleGrant.level })
    .from(roleGrant)
    .where(eq(roleGrant.role, row.role))
  const grants: Grants = {}
  for (const r of rows) grants[r.fieldGroup] = r.level
  return { role: row.role, grants }
}
