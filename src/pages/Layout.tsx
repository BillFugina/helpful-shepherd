import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { Link, NavLink, Outlet, useNavigate } from 'react-router'
import { GuidedTour, useTour } from '../components/GuidedTour'
import { ADMIN_ROLE, levelAtLeast, levelFor, VIEWER_ROLE_LABELS } from '../../shared/access'
import { authClient } from '../lib/auth-client'
import { currentSubscription, saveEndpoint, savedEndpoint, toInput } from '../lib/push'
import { resetTour, startTour } from '../lib/tour'
import { useTRPC } from '../lib/trpc'
import { useMe } from '../lib/useMe'

export function Layout() {
  const me = useMe()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const guest = me.data?.guest === true
  const staff = guest || (me.data?.twoFactorEnabled && me.data.role)
  const sees = (group: 'travel_logistics' | 'housing' | 'contracts' | 'documents') =>
    levelAtLeast(levelFor(me.data?.grants ?? {}, group), 'view')
  const trpc = useTRPC()
  const { mutateAsync: refreshPush } = useMutation(trpc.push.refresh.mutationOptions())
  const { mutateAsync: unsubscribePush } = useMutation(trpc.push.unsubscribe.mutationOptions())
  const canGetAlerts = !guest && me.data?.role === ADMIN_ROLE && me.data.twoFactorEnabled === true
  const touring = useTour()?.open === true

  // Keeps phone alerts working if the browser changed this device's keys or
  // address. Only updates a device this login already turned on.
  useEffect(() => {
    if (!canGetAlerts) return
    currentSubscription()
      .then(async (sub) => {
        if (!sub) return
        const previous = savedEndpoint()
        const res = await refreshPush({
          ...toInput(sub),
          ...(previous && previous !== sub.endpoint ? { previousEndpoint: previous } : {}),
        })
        saveEndpoint(res.on ? sub.endpoint : null)
      })
      .catch(() => undefined)
  }, [canGetAlerts, refreshPush])

  async function signOut() {
    // Phone alerts stop on this device when its login signs out.
    if (!guest) {
      try {
        const sub = await currentSubscription()
        if (sub) {
          await unsubscribePush({ endpoint: sub.endpoint })
          await sub.unsubscribe()
        }
        saveEndpoint(null)
      } catch {
        // Offline or blocked: sign out anyway. The server drops the device once pushes to it fail.
      }
    }
    await authClient.signOut()
    if (guest) {
      resetTour()
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
              {sees('documents') ? <NavLink to="/settings/reminders">Reminders</NavLink> : null}
              {me.data?.role === ADMIN_ROLE ? (
                <>
                  <NavLink to="/admin/access">Access</NavLink>
                  <NavLink to="/admin/audit">Audit log</NavLink>
                  <NavLink to="/admin/export">Export</NavLink>
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
              {canGetAlerts ? (
                <NavLink to="/settings/alerts" title="Phone alerts">
                  Alerts
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
          {touring ? null : (
            <>
              {' · '}
              <button type="button" className="link" onClick={() => startTour(0)}>
                Take the tour
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="demo-banner">Demo with made-up people. Don't enter real personal information.</div>
      )}
      <main>
        <Outlet />
      </main>
      {guest ? <GuidedTour /> : null}
    </div>
  )
}
