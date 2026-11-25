import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router'
import { isMasked, type MaskedValue } from '../../shared/access'
import type { RevealablePersonField } from '../../shared/schemas'
import { errorText } from '../lib/errors'
import { useTRPC } from '../lib/trpc'

const COLUMNS: { key: string; label: string }[] = [
  { key: 'legalName', label: 'Legal name' },
  { key: 'email', label: 'Email' },
  { key: 'cell', label: 'Cell' },
  { key: 'homeAirport', label: 'Home airport' },
  { key: 'dob', label: 'DOB' },
  { key: 'tsaKtn', label: 'TSA/KTN' },
  { key: 'frequentFlyer', label: 'Frequent flyer' },
]

/**
 * Everyone in the app. Columns the role can't see aren't sent at all, and
 * masked values open only through Reveal, which is logged. A name opens the
 * person's profile and productions.
 */
export function PeoplePage() {
  const trpc = useTRPC()
  const people = useQuery(trpc.people.list.queryOptions())

  if (people.isPending) return <p className="muted">Loading…</p>
  if (people.error) return <p className="error">{errorText(people.error)}</p>

  const rows = people.data as Record<string, unknown>[]
  const visible = COLUMNS.filter((c) => rows.some((r) => c.key in r))

  return (
    <section>
      <h1>People</h1>
      <p className="muted">
        {rows.length} made-up people. Columns your role can't see aren't sent to your browser at all.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              {visible.map((c) => (
                <th key={c.key}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)}>
                {visible.map((c) => (
                  <td key={c.key}>
                    <Cell personId={String(r.id)} field={c.key} value={r[c.key]} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function Cell({ personId, field, value }: { personId: string; field: string; value: unknown }) {
  if (field === 'legalName' && typeof value === 'string') return <Link to={`/people/${personId}`}>{value}</Link>
  if (isMasked(value)) return <MaskedCell personId={personId} field={field as RevealablePersonField} value={value} />
  if (value === null || value === undefined || value === '') return <span className="muted">–</span>
  return <>{String(value)}</>
}

function MaskedCell({
  personId,
  field,
  value,
}: {
  personId: string
  field: RevealablePersonField
  value: MaskedValue
}) {
  const trpc = useTRPC()
  const [shown, setShown] = useState<string | null>(null)
  const reveal = useMutation(trpc.people.reveal.mutationOptions({ onSuccess: (r) => setShown(r.value ?? '') }))

  if (!value.hasValue) return <span className="muted">–</span>
  if (shown !== null) {
    return (
      <span className="revealed">
        {shown}{' '}
        <button type="button" className="link" onClick={() => setShown(null)}>
          Hide
        </button>
      </span>
    )
  }
  return (
    <span>
      <span aria-label="hidden">••••••</span>{' '}
      <button
        type="button"
        className="link"
        disabled={reveal.isPending}
        onClick={() => reveal.mutate({ personId, field })}
      >
        Reveal
      </button>
      {reveal.error ? <span className="error"> {errorText(reveal.error)}</span> : null}
    </span>
  )
}
