import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Link, Navigate } from 'react-router'
import { TryDemoButton } from '../components/TryDemoButton'
import { startGuestDemo } from '../lib/demo'
import { useMe } from '../lib/useMe'

/**
 * /demo: a link straight into the guest demo, for a portfolio page. Starts a
 * guest session and lands on the tour. Someone already signed in as staff is
 * asked first, so the link never quietly swaps out a real session.
 */
export function DemoPage() {
  const me = useMe()
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const started = useRef(false)
  const signedOut = !me.isPending && !me.data

  useEffect(() => {
    if (!signedOut || started.current) return
    started.current = true
    void startGuestDemo().then(async (problem) => {
      if (problem) setError(problem)
      else await queryClient.invalidateQueries()
    })
  }, [signedOut, queryClient])

  if (me.isPending) return <p className="muted">Loading…</p>
  if (me.data?.guest) return <Navigate to="/" replace />
  if (me.data) {
    return (
      <section>
        <h1>Guest demo</h1>
        <div className="card">
          <p>You're signed in as {me.data.name}. Switching to the guest demo signs you out of that account.</p>
          <TryDemoButton label="Switch to the guest demo" />
          <Link to="/">Stay signed in</Link>
        </div>
      </section>
    )
  }
  if (error) {
    return (
      <section>
        <h1>Guest demo</h1>
        <div className="card">
          <p className="error">{error}</p>
          <TryDemoButton label="Try again" />
        </div>
      </section>
    )
  }
  return <p className="muted">Starting the demo…</p>
}
