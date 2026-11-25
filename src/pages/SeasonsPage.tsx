import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { PROGRAM_LABELS, PROGRAMS, type Program } from '../../shared/roster'
import { required } from '../components/TermsFields'
import { errorText } from '../lib/errors'
import { formatDate, Select, TextInput, useCan } from '../lib/fields'
import { useTRPC } from '../lib/trpc'

const PROGRAM_OPTIONS = PROGRAMS.map((p) => ({ value: p, label: PROGRAM_LABELS[p] }))

/** Every season, newest first, and a form to start a new one. */
export function SeasonsPage() {
  const trpc = useTRPC()
  const can = useCan()
  const seasons = useQuery(trpc.seasons.list.queryOptions())
  const [adding, setAdding] = useState(false)

  if (seasons.isPending) return <p className="muted">Loading…</p>
  if (seasons.error) return <p className="error">{errorText(seasons.error)}</p>

  return (
    <section>
      <div className="title-row">
        <h1>Seasons</h1>
        {can('general', 'edit') && !adding ? (
          <button type="button" onClick={() => setAdding(true)}>
            New season
          </button>
        ) : null}
      </div>
      {adding ? <NewSeasonForm onDone={() => setAdding(false)} /> : null}
      {seasons.data.length === 0 ? <p className="muted">No seasons yet.</p> : null}
      <ul className="cards">
        {seasons.data.map((s) => (
          <li key={s.id} className="card wide">
            <Link to={`/seasons/${s.id}`} className="card-title">
              {s.name}
            </Link>
            <span className="muted">
              {s.program ? PROGRAM_LABELS[s.program] : null} · {formatDate(s.startsOn)} to {formatDate(s.endsOn)}
            </span>
            <span>
              {s.productionCount} productions · {s.engagementCount} people contracted
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function NewSeasonForm({ onDone }: { onDone: () => void }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const create = useMutation(trpc.seasons.create.mutationOptions())
  const form = useForm({
    defaultValues: { name: '', program: 'main_stage' as Program, startsOn: '', endsOn: '' },
    onSubmit: async ({ value }) => {
      const { id } = await create.mutateAsync(value)
      await queryClient.invalidateQueries({ queryKey: trpc.seasons.list.queryKey() })
      onDone()
      await navigate(`/seasons/${id}`)
    },
  })
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
          {(f) => <TextInput field={f} label="Name" placeholder="2027-28 Season" />}
        </form.Field>
        <form.Field name="program">{(f) => <Select field={f} label="Program" options={PROGRAM_OPTIONS} />}</form.Field>
        <form.Field name="startsOn" validators={{ onChange: required }}>
          {(f) => <TextInput field={f} type="date" label="Starts" />}
        </form.Field>
        <form.Field name="endsOn" validators={{ onChange: required }}>
          {(f) => <TextInput field={f} type="date" label="Ends" />}
        </form.Field>
      </div>
      <div className="actions">
        <button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Saving…' : 'Create season'}
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          Cancel
        </button>
      </div>
      {create.error ? <span className="error">{errorText(create.error)}</span> : null}
    </form>
  )
}
