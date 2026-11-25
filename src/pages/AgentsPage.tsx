import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { required } from '../components/TermsFields'
import { errorText } from '../lib/errors'
import { TextInput, useCan } from '../lib/fields'
import { useTRPC } from '../lib/trpc'
import type { Outputs } from '../lib/types'

type Agent = Outputs['agents']['list'][number]

/** Agents and agencies, picked from when a deal is entered. */
export function AgentsPage() {
  const trpc = useTRPC()
  const can = useCan()
  const [editing, setEditing] = useState<string | null>(null)
  const agents = useQuery({ ...trpc.agents.list.queryOptions(), enabled: can('contact') })

  if (!can('contact')) return <p>Your role doesn't include agent contact details.</p>
  if (agents.isPending) return <p className="muted">Loading…</p>
  if (agents.error) return <p className="error">{errorText(agents.error)}</p>

  return (
    <section>
      <div className="title-row">
        <h1>Agents</h1>
        {can('contact', 'edit') && editing !== 'new' ? (
          <button type="button" onClick={() => setEditing('new')}>
            New agent
          </button>
        ) : null}
      </div>
      {editing === 'new' ? <AgentForm onDone={() => setEditing(null)} /> : null}
      {agents.data.length ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Agency</th>
                <th>Email</th>
                <th>Phone</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {agents.data.map((a) =>
                editing === a.id ? (
                  <tr key={a.id}>
                    <td colSpan={5}>
                      <AgentForm agent={a} onDone={() => setEditing(null)} />
                    </td>
                  </tr>
                ) : (
                  <tr key={a.id}>
                    <td>{a.name}</td>
                    <td>{a.agency ?? <span className="muted">–</span>}</td>
                    <td>{a.email ?? <span className="muted">–</span>}</td>
                    <td>{a.phone ?? <span className="muted">–</span>}</td>
                    <td>
                      {can('contact', 'edit') ? (
                        <button type="button" className="link" onClick={() => setEditing(a.id)}>
                          Edit
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">No agents yet.</p>
      )}
    </section>
  )
}

function AgentForm({ agent, onDone }: { agent?: Agent; onDone: () => void }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const create = useMutation(trpc.agents.create.mutationOptions())
  const update = useMutation(trpc.agents.update.mutationOptions())
  const form = useForm({
    defaultValues: {
      name: agent?.name ?? '',
      agency: agent?.agency ?? '',
      email: agent?.email ?? '',
      phone: agent?.phone ?? '',
    },
    onSubmit: async ({ value }) => {
      const orNull = (s: string) => (s.trim() ? s.trim() : null)
      const fields = {
        name: value.name.trim(),
        agency: orNull(value.agency),
        email: orNull(value.email),
        phone: orNull(value.phone),
      }
      if (agent) await update.mutateAsync({ id: agent.id, ...fields })
      else await create.mutateAsync(fields)
      await queryClient.invalidateQueries({ queryKey: trpc.agents.list.queryKey() })
      onDone()
    },
  })
  const error = create.error ?? update.error
  return (
    <form
      className="card wide"
      onSubmit={(e) => {
        e.preventDefault()
        void form.handleSubmit()
      }}
    >
      <div className="grid">
        <form.Field name="name" validators={{ onChange: required }}>
          {(f) => <TextInput field={f} label="Name" />}
        </form.Field>
        <form.Field name="agency">{(f) => <TextInput field={f} label="Agency" />}</form.Field>
        <form.Field name="email">{(f) => <TextInput field={f} type="email" label="Email" />}</form.Field>
        <form.Field name="phone">{(f) => <TextInput field={f} type="tel" label="Phone" />}</form.Field>
      </div>
      <div className="actions">
        <button type="submit" disabled={create.isPending || update.isPending}>
          {agent ? 'Save' : 'Add agent'}
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          Cancel
        </button>
      </div>
      {error ? <p className="error">{errorText(error)}</p> : null}
    </form>
  )
}
