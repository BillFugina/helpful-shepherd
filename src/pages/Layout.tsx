import { useQueryClient } from '@tanstack/react-query'
import { Link, NavLink, Outlet, useNavigate } from 'react-router'
import { ADMIN_ROLE, levelAtLeast, levelFor, VIEWER_ROLE_LABELS } from '../../shared/access'
import { authClient } from '../lib/auth-client'
import { useMe } from '../lib/useMe'

export function Layout() {
  const me = useMe()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const guest = me.data?.guest === true
  const staff = guest || (me.data?.twoFactorEnabled && me.data.role)
  const sees = (group: 'travel_logistics' | 'housing' | 'contracts' | 'documents') =>
    levelAtLeast(levelFor(me.data?.grants ?? {}, group), 'view')

  async function signOut() {
    await authClient.signOut()
    if (guest) {
      // Back to the home page, then refetch it: a guest may already be on it,
      // and clear() alone would leave its `me` showing the guest.
      await navigate('/')
      await queryClient.resetQueries()
      return
    }
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
              {sees('housing') ? <NavLink to="/housing">Housing</NavLink> : null}
              {sees('contracts') ? <NavLink to="/contracts/settings">Contracts</NavLink> : null}
              {sees('documents') ? <NavLink to="/documents">Documents</NavLink> : null}
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
              {staff && !guest ? (
                <NavLink to="/settings/connections" title="Connected apps">
                  Apps
                </NavLink>
              ) : null}
              <span className="muted" title={me.data.email}>
                {me.data.role ? VIEWER_ROLE_LABELS[me.data.role] : me.data.email}
              </span>
              <button type="button" onClick={signOut}>
                {guest ? 'Leave demo' : 'Sign out'}
              </button>
            </>
          ) : (
            <Link to="/sign-in">Sign in</Link>
          )}
        </nav>
      </header>
      {guest ? (
        <div className="demo-banner guest">
          <strong>Guest demo, read-only.</strong> Every person, flight and contract here is made up. Look around freely;
          nothing you do changes anything. <Link to="/">Where to start</Link>
        </div>
      ) : (
        <div className="demo-banner">Demo with made-up people. Don't enter real personal information.</div>
      )}
      <main>
        <Outlet />
      </main>
    </div>
  )
}
