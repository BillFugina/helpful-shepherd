import { and, eq } from 'drizzle-orm'
import { ADMIN_ROLE, isGuestUserId, levelAtLeast, levelFor, type FieldGroup, type Grants } from '../../shared/access.js'
import { loadAccess } from '../access.js'
import type { Db } from '../db/client.js'
import { user, userRole } from '../db/schema.js'

export interface Recipient {
  userId: string
  email: string
  name: string
  grants: Grants
}

/** Whether a role can see a field group. */
export const sees = (grants: Grants, group: FieldGroup) => levelAtLeast(levelFor(grants, group), 'view')

/**
 * Who gets the scheduled emails: Company Manager logins that have finished
 * two-factor setup and can see `need`. Never the guest. Whether an address
 * actually gets mail is still up to the email rules (allowlist, reserved
 * domains) in server/email/send.ts.
 */
export async function companyManagers(db: Db, need: FieldGroup): Promise<Recipient[]> {
  const rows = await db
    .select({ id: user.id, email: user.email, name: user.name })
    .from(user)
    .innerJoin(userRole, eq(userRole.userId, user.id))
    .where(and(eq(userRole.role, ADMIN_ROLE), eq(user.twoFactorEnabled, true)))
  const out: Recipient[] = []
  for (const r of rows) {
    if (isGuestUserId(r.id)) continue
    const access = await loadAccess(db, r.id)
    if (!access || !sees(access.grants, need)) continue
    out.push({ userId: r.id, email: r.email, name: r.name, grants: access.grants })
  }
  return out
}

/** "Hi Sam," from a login's name, or "Hi," when it has none. */
export function greeting(name: string): string {
  const first = name.trim().split(/\s+/)[0]
  return first ? `Hi ${first},` : 'Hi,'
}
