import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { errorText } from '../lib/errors'
import { useTRPC } from '../lib/trpc'

const MIN = 12

/** Ask for a set-password email. Says the same thing whether or not the address has a login. */
export function RequestPasswordLinkPage() {
  const trpc = useTRPC()
  const request = useMutation(trpc.password.requestLink.mutationOptions())
  const [email, setEmail] = useState('')

  if (request.isSuccess) {
    return (
      <section>
        <h1>Check your email</h1>
        <p className="card">
          If {email.trim()} has a staff login, a link to set its password is on its way. It works once, for an hour.
        </p>
        <Link to="/sign-in">Back to sign in</Link>
      </section>
    )
  }

  return (
    <section>
      <h1>Set your password</h1>
      <p>For a new staff login, or one whose password you’ve forgotten. We’ll email you a link.</p>
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault()
          if (email.trim()) request.mutate({ email: email.trim() })
        }}
      >
        <label>
          Email
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <button type="submit" disabled={request.isPending || !email.trim()}>
          {request.isPending ? 'Sending…' : 'Email me a link'}
        </button>
        {request.error ? <span className="error">{errorText(request.error)}</span> : null}
      </form>
      <Link to="/sign-in">Back to sign in</Link>
    </section>
  )
}

/** The page behind the emailed link. */
export function SetPasswordPage() {
  const { token = '' } = useParams()
  const trpc = useTRPC()
  const set = useMutation(trpc.password.set.mutationOptions())
  const [password, setPassword] = useState('')
  const [again, setAgain] = useState('')
  const [problem, setProblem] = useState<string | null>(null)

  if (set.isSuccess) {
    return (
      <section>
        <h1>Password set</h1>
        <p className="card">
          Sign in with your new password. If you haven’t set up two-factor sign-in yet, the app walks you through it
          next.
        </p>
        <Link to="/sign-in">Sign in</Link>
      </section>
    )
  }

  return (
    <section>
      <h1>Choose a password</h1>
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault()
          if (password.length < MIN) return setProblem(`Use at least ${MIN} characters.`)
          if (password !== again) return setProblem('The two passwords don’t match.')
          setProblem(null)
          set.mutate({ token, password })
        }}
      >
        <label>
          New password
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label>
          Type it again
          <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
        </label>
        <button type="submit" disabled={set.isPending || !password || !again}>
          {set.isPending ? 'Saving…' : 'Set password'}
        </button>
        {problem ? <span className="error">{problem}</span> : null}
        {set.error ? <span className="error">{errorText(set.error)}</span> : null}
      </form>
      {set.error ? <Link to="/set-password">Ask for a new link</Link> : null}
    </section>
  )
}
