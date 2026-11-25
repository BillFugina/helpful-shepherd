import { useQuery } from '@tanstack/react-query'
import { Link, Navigate } from 'react-router'
import { ROLE_LABELS } from '../../shared/access'
import { useTRPC } from '../lib/trpc'
import { useMe } from '../lib/useMe'

export function HomePage() {
  const trpc = useTRPC()
  const health = useQuery(trpc.health.queryOptions())
  const me = useMe()

  if (me.data && !me.data.twoFactorEnabled) return <Navigate to="/setup-2fa" replace />

  return (
    <section>
      <h1>Company management</h1>
      <p className="muted">Server: {describeHealth(health)}</p>
      {me.isPending ? null : me.data ? (
        <div className="card">
          <p>
            Signed in as {me.data.name}
            {me.data.role ? `, ${ROLE_LABELS[me.data.role]}` : ', with no role yet'}.
          </p>
          {me.data.role ? <Link to="/people">Open the people list</Link> : null}
        </div>
      ) : (
        <p>
          <Link to="/sign-in">Sign in</Link> with your staff account.
        </p>
      )}
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
