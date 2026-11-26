import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router'
import { authClient } from '../lib/auth-client'
import { useMe } from '../lib/useMe'

interface PublicClient {
  client_name?: string
  client_uri?: string
}

/**
 * The approval step when an app like Claude asks to connect (OAuth consent).
 * Better Auth sends people here, signed in, with a signed query; approving
 * sends them back to the app.
 */
export function ConnectPage() {
  const me = useMe()
  const [params] = useSearchParams()
  const clientId = params.get('client_id') ?? ''
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const client = useQuery({
    queryKey: ['oauth-public-client', clientId],
    enabled: Boolean(clientId && me.data),
    queryFn: async () => {
      const res = await authClient.$fetch<PublicClient>('/oauth2/public-client', { query: { client_id: clientId } })
      if (res.error) throw new Error(res.error.message || 'Unknown app')
      return res.data
    },
  })

  if (me.isPending) return <p className="muted">Loading…</p>
  if (!me.data) return <Navigate to={`/sign-in?${params.toString()}`} replace />
  if (!clientId || !params.get('sig')) {
    return <p>This page opens when an app asks to connect to your account. Start from the app.</p>
  }
  if (!me.data.twoFactorEnabled) {
    return (
      <p>
        Turn on two-factor sign-in before connecting an app. <Link to="/setup-2fa">Set it up</Link>, then start again
        from the app.
      </p>
    )
  }
  if (!me.data.role) return <p>Your account doesn't have a role yet, so there's nothing to connect.</p>

  const name = client.data?.client_name ?? 'An app'

  async function answer(accept: boolean) {
    setBusy(true)
    setError(null)
    // The OAuth client plugin adds the signed query from this page's URL.
    const res = await authClient.$fetch<{ redirect?: boolean; url?: string }>('/oauth2/consent', {
      method: 'POST',
      body: { accept },
    })
    if (res.error) {
      setBusy(false)
      setError(res.error.message || 'That didn’t work. Start again from the app.')
      return
    }
    // The auth client follows { redirect, url } back to the app; this covers older clients.
    if (res.data?.url) window.location.href = res.data.url
  }

  return (
    <section>
      <h1>Connect {name}?</h1>
      <div className="card">
        {client.isPending ? <p className="muted">Checking the app…</p> : null}
        {client.error ? <p className="error">This app isn't registered. Start again from the app.</p> : null}
        <p>
          <strong>{name}</strong> wants to read the Theatre Raleigh app as you ({me.data.email}).
        </p>
        <ul>
          <li>It sees only what your role can see: seasons, people, deal terms, conflicts, travel and arrivals.</li>
          <li>
            It never sees dates of birth, TSA or frequent flyer numbers, tax or bank documents, or housing addresses and
            door codes.
          </li>
          <li>
            It can't change or send anything. It can leave drafts from acceptance emails for you to check and save.
          </li>
          <li>Every look-up is in the audit log. You can disconnect any time under Connected apps.</li>
        </ul>
        <div className="actions">
          <button type="button" disabled={busy || !client.data} onClick={() => void answer(true)}>
            {busy ? 'Connecting…' : 'Connect'}
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={() => void answer(false)}>
            Don't connect
          </button>
        </div>
        {error ? <p className="error">{error}</p> : null}
      </div>
    </section>
  )
}
