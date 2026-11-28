import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { FIELD_GROUP_LABELS, type FieldGroup } from '../../shared/access'
import { errorText } from '../lib/errors'
import { useTRPC } from '../lib/trpc'

const ACTION_LABELS: Record<string, string> = {
  sign_in: 'Signed in',
  reveal: 'Revealed',
  create: 'Created',
  update: 'Changed',
  delete: 'Deleted',
  download: 'Downloaded',
  send: 'Sent',
  export: 'Exported',
  grant_change: 'Changed access',
  role_change: 'Changed role',
  read: 'Looked up',
  connect: 'Connected an app',
  disconnect: 'Disconnected an app',
}

/** Who viewed, changed, downloaded or sent what. Append-only; filter by person. */
export function AuditPage() {
  const trpc = useTRPC()
  const [personId, setPersonId] = useState('')
  const people = useQuery(trpc.people.list.queryOptions())
  const events = useQuery(trpc.audit.list.queryOptions({ personId: personId || undefined, limit: 100 }))

  return (
    <section>
      <h1>Audit log</h1>
      <label className="inline">
        Person{' '}
        <select value={personId} onChange={(e) => setPersonId(e.target.value)}>
          <option value="">Everyone</option>
          {(people.data ?? []).map((p) => (
            <option key={String(p.id)} value={String(p.id)}>
              {typeof p.legalName === 'string' ? p.legalName : String(p.id)}
            </option>
          ))}
        </select>
      </label>
      {events.isPending ? (
        <p className="muted">Loading…</p>
      ) : events.error ? (
        <p className="error">{errorText(events.error)}</p>
      ) : events.data.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>What</th>
                <th>Person</th>
                <th>Field group</th>
              </tr>
            </thead>
            <tbody>
              {events.data.map((e) => (
                <tr key={e.id}>
                  <td>{e.at.toLocaleString()}</td>
                  <td>{e.actorEmail ?? <span className="muted">–</span>}</td>
                  <td>
                    {ACTION_LABELS[e.action] ?? e.action}
                    {describeDetail(e.detail)}
                    {e.via === 'connector' ? <span className="muted"> · via Claude</span> : null}
                  </td>
                  <td>{e.personName ?? <span className="muted">–</span>}</td>
                  <td>
                    {e.fieldGroup ? FIELD_GROUP_LABELS[e.fieldGroup as FieldGroup] : <span className="muted">–</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">Nothing logged yet.</p>
      )}
    </section>
  )
}

function describeDetail(detail: Record<string, unknown> | null): string {
  if (!detail) return ''
  if (typeof detail.field === 'string') return ` (${detail.field})`
  if (typeof detail.includesSensitive === 'boolean')
    return detail.includesSensitive ? ' all data, with sensitive details' : ' all data'
  if (typeof detail.tool === 'string') return ` (${detail.tool.replaceAll('_', ' ')})`
  if (typeof detail.role === 'string') return ` (${detail.role}: ${String(detail.from)} → ${String(detail.to)})`
  return ''
}
