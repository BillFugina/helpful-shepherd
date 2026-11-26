import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { startGuestDemo } from '../lib/demo'

/** Starts a read-only guest session and lands on the tour. */
export function TryDemoButton({ label = 'Try the demo' }: { label?: string }) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function start() {
    setBusy(true)
    setError(null)
    const problem = await startGuestDemo()
    setBusy(false)
    if (problem) {
      setError(problem)
      return
    }
    queryClient.clear()
    await navigate('/')
  }
  return (
    <div className="actions">
      <button type="button" onClick={start} disabled={busy}>
        {busy ? 'Starting…' : label}
      </button>
      {error ? <span className="error">{error}</span> : null}
    </div>
  )
}
