import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { ADMIN_ROLE } from '../../shared/access'
import { DOCUMENT_TYPE_LABELS } from '../../shared/documents'
import type { ReminderSettings } from '../../shared/reminders'
import { errorText } from '../lib/errors'
import { formatDate, useCan } from '../lib/fields'
import { useTRPC } from '../lib/trpc'
import { useMe } from '../lib/useMe'

const theatreTime = (d: Date) =>
  d.toLocaleString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
  })

const REMINDED: Record<string, string> = {
  sent: 'Reminded',
  held: 'Held (address can’t get email yet)',
  logged: 'Held (email is off here)',
}

/**
 * Automatic reminders: the settings, what's coming up, and a preview of the
 * morning digest. Each reminder is planned from its own date when that date
 * is saved; nothing checks on a timer.
 */
export function RemindersPage() {
  const trpc = useTRPC()
  const me = useMe()
  const can = useCan()
  const settings = useQuery({ ...trpc.reminders.settings.queryOptions(), enabled: can('documents') })
  const upcoming = useQuery({ ...trpc.reminders.upcoming.queryOptions(), enabled: can('documents') })
  const admin = me.data?.role === ADMIN_ROLE
  if (!can('documents')) return <p className="error">Your role has no access to reminders.</p>
  if (settings.isPending) return <p className="muted">Loading…</p>
  if (settings.error) return <p className="error">{errorText(settings.error)}</p>
  const s = settings.data

  return (
    <section>
      <h1>Automatic reminders</h1>
      <p className="muted">
        Each reminder is planned the moment its date is saved: a first rehearsal, someone added to a production, or a
        contract marked sent. Nothing checks on a timer.
      </p>
      {s.mode !== 'live' ? (
        <p className="banner small">
          {s.mode === 'log'
            ? 'Email is turned off here, so reminders are logged, not sent.'
            : 'Email is in test mode: only addresses on the test list get reminders. The rest are logged as held.'}
        </p>
      ) : null}

      <SettingsForm key={`${s.paperworkDaysBefore}-${s.contractDaysAfter}-${s.digestOn}`} s={s} admin={admin} />

      {admin ? <DigestPreview /> : null}

      <section className="card wide" data-tour="reminders-coming-up">
        <h2>Coming up</h2>
        {upcoming.isPending ? <p className="muted">Loading…</p> : null}
        {upcoming.error ? <p className="error">{errorText(upcoming.error)}</p> : null}
        {upcoming.data ? (
          <>
            <h3>Paperwork before first rehearsal</h3>
            {!upcoming.data.productions.length ? (
              <p className="muted">No productions with a first rehearsal still to come.</p>
            ) : (
              upcoming.data.productions.map((p) => (
                <div key={p.id} className="stack">
                  <p>
                    <strong>
                      <Link to={`/productions/${p.id}/documents`}>{p.title}</Link>
                    </strong>
                    {' · '}first rehearsal {formatDate(p.rehearsalStart)}
                    {' · '}
                    {p.reminderAt ? (
                      <>reminders go {theatreTime(new Date(p.reminderAt))}</>
                    ) : (
                      <span className="muted">no reminder planned</span>
                    )}
                  </p>
                  {p.missing.length ? (
                    <ul>
                      {p.missing.map((m) => (
                        <li key={m.engagementId}>
                          <Link to={`/engagements/${m.engagementId}`}>{m.name}</Link>:{' '}
                          {m.forms.map((f) => DOCUMENT_TYPE_LABELS[f]).join(', ')}
                          {m.reminded ? (
                            <span className="muted small"> · {REMINDED[m.reminded] ?? m.reminded}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted small">Nobody is missing forms right now.</p>
                  )}
                </div>
              ))
            )}

            {can('contracts') && s.contractDaysAfter > 0 ? (
              <>
                <h3>Contracts out for signature</h3>
                {!upcoming.data.contracts.length ? (
                  <p className="muted">No contracts are waiting on a signature.</p>
                ) : (
                  <ul>
                    {upcoming.data.contracts.map((c) => (
                      <li key={c.id}>
                        <Link to={`/contracts/${c.id}`}>{c.name}</Link>, {c.production}: sent {formatDate(c.sentOn)}
                        {' · '}
                        {c.late ? (
                          <strong>unsigned since {formatDate(c.lateOn)}</strong>
                        ) : (
                          <>in the digest on {formatDate(c.lateOn)} if still unsigned</>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : null}
          </>
        ) : null}
      </section>
    </section>
  )
}

function SettingsForm({ s, admin }: { s: ReminderSettings; admin: boolean }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const save = useMutation(
    trpc.reminders.save.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.reminders.settings.queryKey() })
        void queryClient.invalidateQueries({ queryKey: trpc.reminders.upcoming.queryKey() })
      },
    }),
  )
  const [paperwork, setPaperwork] = useState(String(s.paperworkDaysBefore))
  const [contracts, setContracts] = useState(String(s.contractDaysAfter))
  const [digest, setDigest] = useState(s.digestOn)
  return (
    <form
      className="card wide"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate({
          paperworkDaysBefore: Number(paperwork),
          contractDaysAfter: Number(contracts),
          digestOn: digest,
        })
      }}
    >
      <h2>Settings</h2>
      <div className="grid">
        <label>
          Email people still missing forms this many days before first rehearsal (0 is off)
          <input
            type="number"
            min={0}
            max={90}
            value={paperwork}
            disabled={!admin}
            onChange={(e) => setPaperwork(e.target.value)}
          />
        </label>
        <label>
          Flag a contract still unsigned this many days after it was sent (0 is off)
          <input
            type="number"
            min={0}
            max={60}
            value={contracts}
            disabled={!admin}
            onChange={(e) => setContracts(e.target.value)}
          />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={digest} disabled={!admin} onChange={(e) => setDigest(e.target.checked)} /> Email
        me a digest at 7 AM on mornings with something new (reminders sent, forms in, forms sent back, contracts that
        turned late). Quiet mornings send nothing.
      </label>
      <p className="muted small">
        Paperwork reminders go at 9 AM theatre time, with the same email and upload link as a reminder you send by hand.
        Each person gets one per first rehearsal.
      </p>
      {admin ? (
        <div className="actions">
          <button type="submit" disabled={save.isPending}>
            Save
          </button>
          {save.isSuccess ? <span className="muted small">Saved, and every reminder planned again</span> : null}
        </div>
      ) : (
        <p className="muted small">Only the Company Manager can change these.</p>
      )}
      {save.error ? <p className="error">{errorText(save.error)}</p> : null}
    </form>
  )
}

function DigestPreview() {
  const trpc = useTRPC()
  const send = useMutation(trpc.reminders.sendDigestNow.mutationOptions())
  return (
    <section className="card wide">
      <h2>Morning digest</h2>
      <p className="muted small">See what the digest looks like: this emails you one now, covering the last 7 days.</p>
      <div className="actions">
        <button type="button" disabled={send.isPending} onClick={() => send.mutate()}>
          Email me a digest now
        </button>
        {send.data?.delivery === 'sent' ? <span className="muted small">Sent. Check your inbox.</span> : null}
      </div>
      {send.data && send.data.delivery !== 'sent' ? (
        <>
          <p className="muted small">{send.data.reason ?? 'It wasn’t sent.'} Here’s what it would say:</p>
          <pre className="email-preview">{send.data.text}</pre>
        </>
      ) : null}
      {send.error ? <p className="error">{errorText(send.error)}</p> : null}
    </section>
  )
}
