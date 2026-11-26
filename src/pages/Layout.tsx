import { useQueryClient } from '@tanstack/react-query'
import { Link, NavLink, Outlet, useNavigate } from 'react-router'
import { ADMIN_ROLE, levelAtLeast, levelFor, ROLE_LABELS } from '../../shared/access'
import { authClient } from '../lib/auth-client'
import { useMe } from '../lib/useMe'

export function Layout() {
  const me = useMe()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const staff = me.data?.twoFactorEnabled && me.data.role
  const sees = (group: 'travel_logistics' | 'housing_access' | 'contracts') =>
    levelAtLeast(levelFor(me.data?.grants ?? {}, group), 'view')

  async function signOut() {
    await authClient.signOut()
    queryClient.clear()
    await navigate('/sign-in')
  }

  return (
    <div className="shell">
      <header>
        <Link to="/" className="brand">
          Theatre Raleigh
        </Link>
        <nav>
          {staff ? (
            <>
              <NavLink to="/seasons">Seasons</NavLink>
              <NavLink to="/people">People</NavLink>
              <NavLink to="/agents">Agents</NavLink>
              {levelAtLeast(levelFor(me.data?.grants ?? {}, 'general'), 'edit') ? (
                <NavLink to="/drafts">Drafts</NavLink>
              ) : null}
              {sees('travel_logistics') ? <NavLink to="/arrivals">Arrivals</NavLink> : null}
              {sees('housing_access') ? <NavLink to="/housing">Housing</NavLink> : null}
              {sees('contracts') ? <NavLink to="/contracts/settings">Contracts</NavLink> : null}
              {me.data?.role === ADMIN_ROLE ? (
                <>
                  <NavLink to="/admin/access">Access</NavLink>
                  <NavLink to="/admin/audit">Audit log</NavLink>
                </>
              ) : null}
            </>
          ) : null}
          {me.data ? (
            <>
              {staff ? (
                <NavLink to="/settings/connections" title="Connected apps">
                  Apps
                </NavLink>
              ) : null}
              <span className="muted" title={me.data.email}>
                {me.data.role ? ROLE_LABELS[me.data.role] : me.data.email}
              </span>
              <button type="button" onClick={signOut}>
                Sign out
              </button>
            </>
          ) : (
            <Link to="/sign-in">Sign in</Link>
          )}
        </nav>
      </header>
      <div className="demo-banner">Demo with made-up people. Don't enter real personal information.</div>
      <main>
        <Outlet />
      </main>
    </div>
  )
}
