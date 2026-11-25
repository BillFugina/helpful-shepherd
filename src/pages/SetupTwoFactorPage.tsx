import { useQueryClient } from '@tanstack/react-query'
import QRCode from 'qrcode'
import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { authClient } from '../lib/auth-client'
import { useMe } from '../lib/useMe'

type Step =
  | { kind: 'password' }
  | { kind: 'scan'; qr: string; secret: string; backupCodes: string[] }
  | { kind: 'backup-codes'; backupCodes: string[] }

/** Two-factor is required for every staff account; nothing else opens until it's on. */
export function SetupTwoFactorPage() {
  const me = useMe()
  const [step, setStep] = useState<Step>({ kind: 'password' })
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  if (me.isPending) return <p className="muted">Loading…</p>
  if (!me.data) return <Navigate to="/sign-in" replace />
  if (me.data.twoFactorEnabled && step.kind !== 'backup-codes') return <Navigate to="/" replace />

  async function start(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const result = await authClient.twoFactor.enable({ password })
    setBusy(false)
    if (result.error || !result.data || !('totpURI' in result.data)) {
      setError(result.error?.message || 'Could not start setup. Check your password.')
      return
    }
    const uri = result.data.totpURI
    const secret = new URL(uri).searchParams.get('secret') ?? ''
    const qr = await QRCode.toDataURL(uri, { margin: 1, width: 220 })
    setPassword('')
    setStep({ kind: 'scan', qr, secret, backupCodes: result.data.backupCodes })
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault()
    if (step.kind !== 'scan') return
    setBusy(true)
    setError(null)
    const result = await authClient.twoFactor.verifyTotp({ code: code.replace(/\s/g, '') })
    setBusy(false)
    if (result.error) {
      setError('That code didn’t match. Check the time on your phone and try the newest code.')
      return
    }
    setStep({ kind: 'backup-codes', backupCodes: step.backupCodes })
  }

  if (step.kind === 'backup-codes') {
    return (
      <section>
        <h1>Two-factor is on</h1>
        <div className="card">
          <p>
            Print or save these backup codes somewhere safe. Each works once, if your phone isn't handy. They won't be
            shown again.
          </p>
          <ul className="codes">
            {step.backupCodes.map((c) => (
              <li key={c}>
                <code>{c}</code>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={async () => {
              await queryClient.invalidateQueries()
              await navigate('/')
            }}
          >
            I've saved them
          </button>
        </div>
      </section>
    )
  }

  return (
    <section>
      <h1>Set up two-factor sign-in</h1>
      {step.kind === 'password' ? (
        <form className="card" onSubmit={start}>
          <p>Every staff account needs an authenticator app (like 1Password, Google Authenticator or Authy).</p>
          <label>
            Confirm your password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button type="submit" disabled={busy || !password}>
            {busy ? 'Starting…' : 'Continue'}
          </button>
          {error ? <span className="error">{error}</span> : null}
        </form>
      ) : (
        <form className="card" onSubmit={verify}>
          <p>Scan this with your authenticator app, then enter the 6-digit code it shows.</p>
          <img src={step.qr} alt="QR code for your authenticator app" width={220} height={220} />
          <details>
            <summary>Can't scan? Enter this key instead</summary>
            <code className="secret">{step.secret}</code>
          </details>
          <label>
            6-digit code
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <button type="submit" disabled={busy || !code.trim()}>
            {busy ? 'Checking…' : 'Turn on two-factor'}
          </button>
          {error ? <span className="error">{error}</span> : null}
        </form>
      )}
    </section>
  )
}
