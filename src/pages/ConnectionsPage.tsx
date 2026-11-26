import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { errorText } from '../lib/errors'
import { useTRPC } from '../lib/trpc'

/** Apps (like Claude) this person has connected to their account, with a way to cut them off. */
export function ConnectionsPage() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const list = useQuery(trpc.connections.list.queryOptions())
  const disconnect = useMutation(
    trpc.connections.disconnect.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.connections.list.queryKey() }),
    }),
  )

  return (
    <section>
      <h1>Connected apps</h1>
      <p className="muted">
        Apps you've let read the app as you, like Claude. They see only what your role can see, never dates of birth,
        travel IDs, tax or bank documents, or housing addresses and door codes, and they can't change anything except to
        leave drafts for review. Disconnecting stops access right away.
      </p>
      {list.isPending ? (
        <p className="muted">Loading…</p>
      ) : list.error ? (
        <p className="error">{errorText(list.error)}</p>
      ) : list.data.length === 0 ? (
        <p>No apps connected.</p>
      ) : (
        <ul className="stack">
          {list.data.map((c) => (
            <li key={c.clientId} className="card row">
              <div>
                <strong>{c.name ?? 'Unnamed app'}</strong>
                <div className="muted small">Connected {new Date(c.connectedAt).toLocaleDateString('en-US')}</div>
              </div>
              <button
                type="button"
                className="secondary"
                disabled={disconnect.isPending}
                onClick={() => disconnect.mutate({ clientId: c.clientId })}
              >
                Disconnect
              </button>
            </li>
          ))}
        </ul>
      )}
      {disconnect.error ? <p className="error">{errorText(disconnect.error)}</p> : null}
    </section>
  )
}
