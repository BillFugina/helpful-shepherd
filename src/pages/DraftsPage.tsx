import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { errorText } from '../lib/errors'
import { useCan } from '../lib/fields'
import { useTRPC } from '../lib/trpc'

const when = (d: Date | string) =>
  new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

/** Drafts the Claude connector made from acceptance emails, waiting for a person to check and save. */
export function DraftsPage() {
  const trpc = useTRPC()
  const can = useCan()
  const drafts = useQuery({ ...trpc.drafts.list.queryOptions({ status: 'pending' }), enabled: can('general', 'edit') })

  if (!can('general', 'edit')) return <p>Your role can view the roster but not add to it.</p>
  if (drafts.isPending) return <p className="muted">Loading…</p>
  if (drafts.error) return <p className="error">{errorText(drafts.error)}</p>

  return (
    <section>
      <h1>Drafts from Claude</h1>
      <p className="muted">
        When you paste an acceptance email into Claude, it saves a draft here. Open one to check it against the email,
        then save it to the roster or dismiss it.
      </p>
      {drafts.data.length === 0 ? (
        <p>No drafts waiting.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Who</th>
              <th>Role</th>
              <th>Production</th>
              <th>Made</th>
            </tr>
          </thead>
          <tbody>
            {drafts.data.map((d) => (
              <tr key={d.id}>
                <td>
                  <Link to={`/productions/${d.productionId}/add?draft=${d.id}`}>{d.name ?? 'Unreadable draft'}</Link>
                  {d.returningPerson ? <span className="muted small"> returning</span> : null}
                </td>
                <td>{d.role}</td>
                <td>
                  {d.productionTitle} <span className="muted small">{d.seasonName}</span>
                </td>
                <td>{when(d.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
