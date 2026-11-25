import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import {
  CONTRACT_TYPE_LABELS,
  PIPELINE_LABELS,
  PIPELINE_STATUSES,
  PROGRAM_LABELS,
  type PipelineStatus,
} from '../../shared/roster'
import { required } from '../components/TermsFields'
import { errorText } from '../lib/errors'
import { displayName, formatDate, TextArea, TextInput, useCan } from '../lib/fields'
import { useTRPC } from '../lib/trpc'
import type { Outputs } from '../lib/types'

/** The season at a glance: each production, its people and where they are in the pipeline. */
export function SeasonPage() {
  const { seasonId = '' } = useParams()
  const trpc = useTRPC()
  const can = useCan()
  const dashboard = useQuery(trpc.seasons.dashboard.queryOptions({ id: seasonId }))
  const [adding, setAdding] = useState(false)

  if (dashboard.isPending) return <p className="muted">Loading…</p>
  if (dashboard.error) return <p className="error">{errorText(dashboard.error)}</p>
  const { season, productions } = dashboard.data
  const total = productions.reduce((n, p) => n + p.engagements.length, 0)

  return (
    <section>
      <p className="crumbs">
        <Link to="/seasons">Seasons</Link>
      </p>
      <div className="title-row">
        <h1>{season.name}</h1>
        {can('general', 'edit') && !adding ? (
          <button type="button" onClick={() => setAdding(true)}>
            Add production
          </button>
        ) : null}
      </div>
      <p className="muted">
        {season.program ? PROGRAM_LABELS[season.program] : null} · {formatDate(season.startsOn)} to{' '}
        {formatDate(season.endsOn)} · {productions.length} productions · {total} people contracted
      </p>
      {adding ? <ProductionForm seasonId={season.id} onDone={() => setAdding(false)} /> : null}
      {productions.length === 0 && !adding ? <p className="muted">No productions yet.</p> : null}
      {productions.map((p) => (
        <ProductionCard key={p.id} seasonId={season.id} production={p} />
      ))}
    </section>
  )
}

type ProductionRow = Outputs['seasons']['dashboard']['productions'][number]

function ProductionCard({ seasonId, production: p }: { seasonId: string; production: ProductionRow }) {
  const can = useCan()
  const [editing, setEditing] = useState(false)
  const counts = new Map<PipelineStatus, number>()
  for (const e of p.engagements)
    if (e.pipelineStatus) counts.set(e.pipelineStatus, (counts.get(e.pipelineStatus) ?? 0) + 1)
  const showAgent = p.engagements.some((e) => e.agentName !== undefined)

  return (
    <article className="production">
      <header className="title-row">
        <div>
          <h2>{p.title}</h2>
          <p className="muted small">
            Rehearsal {formatDate(p.rehearsalStart)} · Tech {formatDate(p.techStart)} · Opens {formatDate(p.opening)} ·
            Closes {formatDate(p.closing)}
          </p>
          {p.performanceSchedule ? <p className="muted small">{p.performanceSchedule}</p> : null}
        </div>
        {can('general', 'edit') ? (
          <div className="actions">
            <Link className="button" to={`/productions/${p.id}/add`}>
              Add person
            </Link>
            <Link className="button secondary" to={`/productions/${p.id}/import`}>
              Import
            </Link>
            <button type="button" className="link" onClick={() => setEditing(!editing)}>
              {editing ? 'Close' : 'Edit dates'}
            </button>
          </div>
        ) : null}
      </header>
      {editing ? <ProductionForm seasonId={seasonId} production={p} onDone={() => setEditing(false)} /> : null}
      {p.engagements.length ? (
        <>
          <ul className="chips" aria-label="Pipeline">
            {PIPELINE_STATUSES.filter((s) => counts.get(s)).map((s) => (
              <li key={s} className={`chip status-${s}`}>
                {PIPELINE_LABELS[s]}: {counts.get(s)}
              </li>
            ))}
          </ul>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Contract</th>
                  {showAgent ? <th>Agent</th> : null}
                  <th>Status</th>
                  <th>Conflicts</th>
                </tr>
              </thead>
              <tbody>
                {p.engagements.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <Link to={`/people/${e.person.id}`}>{displayName(e.person)}</Link>
                    </td>
                    <td>
                      <Link to={`/engagements/${e.id}`}>{e.role ?? 'Open'}</Link>
                    </td>
                    <td>{e.contractType ? CONTRACT_TYPE_LABELS[e.contractType] : '–'}</td>
                    {showAgent ? <td>{e.agentName ?? <span className="muted">–</span>}</td> : null}
                    <td>
                      <StatusCell id={e.id} seasonId={seasonId} status={e.pipelineStatus} />
                    </td>
                    <td>{e.conflictCount || <span className="muted">–</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="muted">Nobody contracted yet.</p>
      )}
    </article>
  )
}

/** The pipeline stage, changeable in place by roles that can edit the roster. */
export function StatusCell({
  id,
  seasonId,
  status,
}: {
  id: string
  seasonId?: string
  status: PipelineStatus | undefined
}) {
  const trpc = useTRPC()
  const can = useCan()
  const queryClient = useQueryClient()
  const setStatus = useMutation(
    trpc.engagements.setStatus.mutationOptions({
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: trpc.engagements.get.queryKey({ id }) })
        if (seasonId)
          await queryClient.invalidateQueries({ queryKey: trpc.seasons.dashboard.queryKey({ id: seasonId }) })
      },
    }),
  )
  if (!status) return <span className="muted">–</span>
  if (!can('general', 'edit')) return <span className={`chip status-${status}`}>{PIPELINE_LABELS[status]}</span>
  return (
    <>
      <select
        aria-label="Pipeline status"
        className={`status-${status}`}
        value={status}
        disabled={setStatus.isPending}
        onChange={(ev) => setStatus.mutate({ id, status: ev.target.value as PipelineStatus })}
      >
        {PIPELINE_STATUSES.map((s) => (
          <option key={s} value={s}>
            {PIPELINE_LABELS[s]}
          </option>
        ))}
      </select>
      {setStatus.error ? <span className="error small"> {errorText(setStatus.error)}</span> : null}
    </>
  )
}

function ProductionForm({
  seasonId,
  production,
  onDone,
}: {
  seasonId: string
  production?: ProductionRow
  onDone: () => void
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const create = useMutation(trpc.productions.create.mutationOptions())
  const update = useMutation(trpc.productions.update.mutationOptions())
  const blank = (v: string | null | undefined) => v ?? ''
  const orNull = (v: string) => (v.trim() ? v : null)
  const form = useForm({
    defaultValues: {
      title: blank(production?.title),
      rehearsalStart: blank(production?.rehearsalStart),
      techStart: blank(production?.techStart),
      opening: blank(production?.opening),
      closing: blank(production?.closing),
      performanceSchedule: blank(production?.performanceSchedule),
    },
    onSubmit: async ({ value }) => {
      const fields = {
        title: value.title,
        rehearsalStart: orNull(value.rehearsalStart),
        techStart: orNull(value.techStart),
        opening: orNull(value.opening),
        closing: orNull(value.closing),
        performanceSchedule: orNull(value.performanceSchedule),
      }
      if (production) await update.mutateAsync({ id: production.id, ...fields })
      else await create.mutateAsync({ seasonId, ...fields })
      await queryClient.invalidateQueries({ queryKey: trpc.seasons.dashboard.queryKey({ id: seasonId }) })
      await queryClient.invalidateQueries({ queryKey: trpc.seasons.list.queryKey() })
      onDone()
    },
  })
  const error = create.error ?? update.error
  const busy = create.isPending || update.isPending
  return (
    <form
      className="card wide"
      onSubmit={(e) => {
        e.preventDefault()
        void form.handleSubmit()
      }}
    >
      <div className="grid">
        <form.Field name="title" validators={{ onChange: required }}>
          {(f) => <TextInput field={f} label="Title" />}
        </form.Field>
        <form.Field name="rehearsalStart">
          {(f) => <TextInput field={f} type="date" label="Rehearsal starts" />}
        </form.Field>
        <form.Field name="techStart">{(f) => <TextInput field={f} type="date" label="Tech starts" />}</form.Field>
        <form.Field name="opening">{(f) => <TextInput field={f} type="date" label="Opening" />}</form.Field>
        <form.Field name="closing">{(f) => <TextInput field={f} type="date" label="Closing" />}</form.Field>
        <form.Field name="performanceSchedule">{(f) => <TextArea field={f} label="Performance schedule" />}</form.Field>
      </div>
      <div className="actions">
        <button type="submit" disabled={busy}>
          {busy ? 'Saving…' : production ? 'Save dates' : 'Add production'}
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          Cancel
        </button>
      </div>
      {error ? <span className="error">{errorText(error)}</span> : null}
    </form>
  )
}
