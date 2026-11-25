import { useForm } from '@tanstack/react-form'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { z } from 'zod'
import { authClient } from '../lib/auth-client'

const credentials = z.object({
  email: z.email('Enter a valid email'),
  password: z.string().min(1, 'Enter your password'),
})

/** Email and password, then the second factor when the account has one. */
export function SignInPage() {
  const [step, setStep] = useState<'password' | 'second-factor'>('password')
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  async function finish() {
    await queryClient.invalidateQueries()
    await navigate('/')
  }

  const form = useForm({
    defaultValues: { email: '', password: '' },
    validators: { onSubmit: credentials },
    onSubmit: async ({ value }) => {
      setError(null)
      const result = await authClient.signIn.email({ email: value.email, password: value.password })
      if (result.error) {
        setError(
          result.error.status === 429
            ? 'Too many attempts. Wait a minute and try again.'
            : result.error.message || 'Sign-in failed.',
        )
        return
      }
      if ((result.data as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect) {
        setStep('second-factor')
        return
      }
      // No second factor yet: home sends them to set it up.
      await finish()
    },
  })

  if (step === 'second-factor') return <SecondFactor onDone={finish} />

  return (
    <section>
      <h1>Sign in</h1>
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault()
          void form.handleSubmit()
        }}
      >
        {(['email', 'password'] as const).map((name) => (
          <form.Field key={name} name={name}>
            {(field) => (
              <label>
                {name === 'email' ? 'Email' : 'Password'}
                <input
                  type={name}
                  autoComplete={name === 'email' ? 'username' : 'current-password'}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
                {field.state.meta.errors.map((err, i) => (
                  <span key={i} className="error">
                    {typeof err === 'string' ? err : err?.message}
                  </span>
                ))}
              </label>
            )}
          </form.Field>
        ))}
        <form.Subscribe selector={(s) => s.isSubmitting}>
          {(isSubmitting) => (
            <button type="submit" disabled={isSubmitting}>
              {isSubmitting ? 'Signing in…' : 'Sign in'}
            </button>
          )}
        </form.Subscribe>
        {error ? <span className="error">{error}</span> : null}
      </form>
      <p className="muted">Staff accounts only. The Company Manager creates them.</p>
    </section>
  )
}

function SecondFactor({ onDone }: { onDone: () => Promise<void> }) {
  const [useBackup, setUseBackup] = useState(false)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const result = useBackup
      ? await authClient.twoFactor.verifyBackupCode({ code: code.trim() })
      : await authClient.twoFactor.verifyTotp({ code: code.replace(/\s/g, '') })
    setBusy(false)
    if (result.error) {
      setError(result.error.status === 429 ? 'Too many attempts. Wait a minute.' : 'That code didn’t work.')
      return
    }
    await onDone()
  }

  return (
    <section>
      <h1>Two-factor check</h1>
      <form className="card" onSubmit={submit}>
        <label>
          {useBackup ? 'Backup code' : 'Code from your authenticator app'}
          <input
            inputMode={useBackup ? 'text' : 'numeric'}
            autoComplete="one-time-code"
            autoFocus
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </label>
        <button type="submit" disabled={busy || !code.trim()}>
          {busy ? 'Checking…' : 'Continue'}
        </button>
        {error ? <span className="error">{error}</span> : null}
      </form>
      <button type="button" className="link" onClick={() => setUseBackup(!useBackup)}>
        {useBackup ? 'Use my authenticator app instead' : 'Use a backup code instead'}
      </button>
    </section>
  )
}
