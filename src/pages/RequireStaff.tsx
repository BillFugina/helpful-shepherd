import { Navigate, Outlet } from 'react-router'
import { useMe } from '../lib/useMe'

/** Sends people to sign-in or two-factor setup before any data page renders. */
export function RequireStaff() {
  const me = useMe()
  if (me.isPending) return <p className="muted">Loading…</p>
  if (!me.data) return <Navigate to="/sign-in" replace />
  if (!me.data.twoFactorEnabled) return <Navigate to="/setup-2fa" replace />
  if (!me.data.role) {
    return <p>Your account doesn't have a role yet, so there's nothing to show. Ask the Company Manager to add you.</p>
  }
  return <Outlet />
}
