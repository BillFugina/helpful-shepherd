import { useQuery } from '@tanstack/react-query'
import { Link, Navigate } from 'react-router'
import { VIEWER_ROLE_LABELS } from '../../shared/access'
import { TryDemoButton } from '../components/TryDemoButton'
import { useTour } from '../components/GuidedTour'
import { startTour } from '../lib/tour'
import { useTRPC } from '../lib/trpc'
import { useMe } from '../lib/useMe'

export function HomePage() {
  const trpc = useTRPC()
  const health = useQuery(trpc.health.queryOptions())
  const me = useMe()

  if (me.data?.guest) return <GuestTour />
  if (me.data && !me.data.twoFactorEnabled) return <Navigate to="/setup-2fa" replace />

  return (
    <section>
      <h1>Company management</h1>
      <p className="muted">Server: {describeHealth(health)}</p>
      {me.isPending ? null : me.data ? (
        <div className="card">
          <p>
            Signed in as {me.data.name}
            {me.data.role ? `, ${VIEWER_ROLE_LABELS[me.data.role]}` : ', with no role yet'}.
          </p>
          {me.data.role ? <Link to="/seasons">Open the seasons</Link> : null}
        </div>
      ) : (
        <>
          <div className="card">
            <p>
              Company management for a regional theater: every contracted artist on every production, with their deal,
              contracts, flights, rental cars and housing in one place, and field-level permissions so Finance sees only
              what Finance needs.
            </p>
            <TryDemoButton />
            <p className="muted small">No sign-up. You look around as a read-only guest, with a made-up 2027 season.</p>
          </div>
          <p>
            Staff: <Link to="/sign-in">sign in</Link> with your account.
          </p>
        </>
      )}
    </section>
  )
}

/** What a guest sees first: where to look, in the order that shows the app best. */
function GuestTour() {
  const touring = useTour()?.open === true
  return (
    <section>
      <h1>Welcome to the demo</h1>
      <p>
        This is a company management app for a regional theater, filled with a made-up 2027 season: five productions,
        twenty artists, their agents, deals, contracts, flights and housing. You're signed in as a guest, so you can
        open everything except the private fields (dates of birth, travel IDs, tax and bank documents), and nothing you
        do changes anything.
      </p>
      {touring ? null : (
        <div className="actions">
          <button type="button" onClick={() => startTour(0)}>
            Take the one-minute tour
          </button>
        </div>
      )}
      <div className="card">
        <h2>Or look around on your own</h2>
        <ol className="tour">
          <li>
            <Link to="/seasons">Seasons</Link>: open the 2027 season to see every production and each person's stage,
            from offer accepted to departed.
          </li>
          <li>
            <Link to="/arrivals">Arrivals</Link>: the travel-day board. Your own demo clock starts on the first travel
            day, with a delay, a gate change and an early landing from a simulated flight feed. Step it forward an hour
            at a time.
          </li>
          <li>
            <Link to="/housing">Housing</Link>: who sleeps where, with warnings when a room breaks someone's housing
            needs.
          </li>
          <li>
            <Link to="/contracts/settings">Contracts</Link>: union and rider templates. From a production, open its
            contracts to see each one filled from the roster.
          </li>
          <li>
            <Link to="/people">People</Link> and <Link to="/agents">Agents</Link>: one record per person, reused every
            season.
          </li>
        </ol>
      </div>
      <p className="muted small">
        Staff sign in with a password and an authenticator app; the guest demo lasts two hours. Built with React, tRPC,
        Drizzle on Postgres and Better Auth.
      </p>
    </section>
  )
}

function describeHealth(health: {
  isPending: boolean
  error: { message: string } | null
  data?: { ok: boolean; checks: { authSecret: boolean; fieldKey: boolean; database: string } }
}): string {
  if (health.isPending) return 'checking…'
  if (!health.data) return `down (${health.error?.message ?? 'no response'})`
  if (health.data.ok) return 'up'
  const problems: string[] = []
  if (!health.data.checks.authSecret) problems.push('BETTER_AUTH_SECRET missing or too short')
  if (!health.data.checks.fieldKey) problems.push('FIELD_ENCRYPTION_KEY missing or wrong length')
  if (health.data.checks.database !== 'ok') problems.push(`database ${health.data.checks.database}`)
  return `up, but ${problems.join('; ')}`
}
