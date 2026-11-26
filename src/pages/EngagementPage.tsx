import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router'
import { CONTRACT_TYPE_LABELS } from '../../shared/roster'
import { required, TermsFields, type HasField } from '../components/TermsFields'
import { errorText } from '../lib/errors'
import { displayName, dollars, draftFromEngagement, formatDate, termsFromDraft, TextInput, useCan } from '../lib/fields'
import { useTRPC } from '../lib/trpc'
import type { Outputs } from '../lib/types'
import { StatusCell } from './SeasonPage'

type Detail = Outputs['engagements']['get']

/** One person's deal on one production: terms, agent, conflicts and status. */
export function EngagementPage() {
  const { engagementId = '' } = useParams()
  const trpc = useTRPC()
  const can = useCan()
  const detail = useQuery(trpc.engagements.get.queryOptions({ id: engagementId }))

  if (detail.isPending) return <p className="muted">Loading…</p>
  if (detail.error) return <p className="error">{errorText(detail.error)}</p>
  const d = detail.data
  const e = d.engagement

  return (
    <section>
      <p className="crumbs">
        <Link to={`/seasons/${d.production.seasonId}`}>{d.seasonName}</Link> · {d.production.title}
      </p>
      <div className="title-row">
        <h1>
          <Link to={`/people/${d.person.id}`}>{displayName(d.person)}</Link>
          {e.role ? <span className="muted"> as {e.role}</span> : null}
        </h1>
        <StatusCell id={engagementId} seasonId={d.production.seasonId} status={e.pipelineStatus} />
      </div>
      <p className="muted">
        {[d.person.email, d.person.cell, d.person.homeAirport ? `Flies from ${d.person.homeAirport}` : null]
          .filter(Boolean)
          .join(' · ')}
      </p>

      {can('travel_logistics') || can('housing_access') ? (
        <p>
          <Link to={`/engagements/${engagementId}/travel`}>Travel and housing</Link>
        </p>
      ) : null}
      {can('general', 'edit') ? <EditTerms detail={d} /> : <ReadTerms detail={d} />}
      <Conflicts detail={d} />
      {can('general', 'edit') && can('contact', 'edit') && can('pay_terms', 'edit') ? (
        <RemoveButton detail={d} />
      ) : null}
    </section>
  )
}

function ReadTerms({ detail: d }: { detail: Detail }) {
  const e = d.engagement
  const yes = (v: boolean | undefined) => (v ? 'Yes' : 'No')
  const rows: [string, string | undefined][] = [
    ['Contract', e.contractType ? CONTRACT_TYPE_LABELS[e.contractType] : undefined],
    ['Weekly pay', 'weeklyPayCents' in e ? dollars(e.weeklyPayCents) : undefined],
    ['Weekly stipend', 'weeklyStipendCents' in e ? dollars(e.weeklyStipendCents) : undefined],
    ['Agent', d.agent ? [d.agent.name, d.agent.agency].filter(Boolean).join(', ') : undefined],
    [
      'Commission',
      'commissionPercent' in e ? (e.commissionPercent === null ? 'None' : `${e.commissionPercent}%`) : undefined,
    ],
    ['Travel provided', yes(e.travelProvided)],
    ['Rental car', yes(e.carProvided)],
    ['Housing provided', yes(e.housingProvided)],
    ['Preferred arrival', formatDate(e.preferredArrival)],
    ['Preferred departure', formatDate(e.preferredDeparture)],
    ['Printed script', yes(e.scriptNeeded)],
    ['Comp tickets', e.compAllotment === undefined ? undefined : String(e.compAllotment)],
    ['Notes', e.notes ?? undefined],
  ]
  return (
    <dl className="facts card wide">
      {rows
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
    </dl>
  )
}

function EditTerms({ detail: d }: { detail: Detail }) {
  const trpc = useTRPC()
  const can = useCan()
  const queryClient = useQueryClient()
  const payTerms = can('pay_terms', 'edit')
  const contactEdit = can('contact', 'edit')
  const agents = useQuery({ ...trpc.agents.list.queryOptions(), enabled: contactEdit })
  const update = useMutation(trpc.engagements.update.mutationOptions())
  const form = useForm({
    defaultValues: { terms: draftFromEngagement(d.engagement), agentId: d.agent?.id ?? '' },
    onSubmit: async ({ value, formApi }) => {
      // Status changes through the status menu at the top, so a stale copy here never overwrites it.
      await update.mutateAsync({
        id: d.engagement.id,
        ...termsFromDraft(value.terms, { payTerms, status: false }),
        ...(contactEdit ? { agentId: value.agentId || null } : {}),
      })
      formApi.reset(value)
      await queryClient.invalidateQueries({ queryKey: trpc.engagements.get.queryKey({ id: d.engagement.id }) })
      await queryClient.invalidateQueries({ queryKey: trpc.seasons.dashboard.queryKey({ id: d.production.seasonId }) })
    },
  })
  const F = form as unknown as HasField

  return (
    <form
      className="stack"
      onSubmit={(ev) => {
        ev.preventDefault()
        void form.handleSubmit()
      }}
    >
      <fieldset>
        <legend>Role</legend>
        <TermsFields form={F} prefix="terms." part="role" />
      </fieldset>
      {payTerms ? (
        <fieldset>
          <legend>Pay</legend>
          <TermsFields form={F} prefix="terms." part="pay" />
        </fieldset>
      ) : null}
      {contactEdit ? (
        <fieldset>
          <legend>Agent</legend>
          <div className="grid">
            <form.Field name="agentId">
              {(f) => (
                <label>
                  Agent
                  <select value={f.state.value} onChange={(ev) => f.handleChange(ev.target.value)}>
                    <option value="">No agent</option>
                    {(agents.data ?? []).map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                        {a.agency ? `, ${a.agency}` : ''}
                      </option>
                    ))}
                  </select>
                  <span className="muted small">
                    New agents go on the <Link to="/agents">Agents</Link> page.
                  </span>
                </label>
              )}
            </form.Field>
          </div>
          {payTerms ? <TermsFields form={F} prefix="terms." part="commission" /> : null}
        </fieldset>
      ) : null}
      <fieldset>
        <legend>Travel and housing</legend>
        <TermsFields form={F} prefix="terms." part="logistics" />
      </fieldset>
      <fieldset>
        <legend>The rest</legend>
        <TermsFields form={F} prefix="terms." part="extras" hideStatus />
      </fieldset>
      <div className="actions">
        <form.Subscribe selector={(s) => [s.isSubmitting, s.isDirty] as const}>
          {([submitting, dirty]) => (
            <button type="submit" disabled={submitting || !dirty}>
              {submitting ? 'Saving…' : 'Save changes'}
            </button>
          )}
        </form.Subscribe>
        {update.isSuccess ? <span className="muted">Saved.</span> : null}
      </div>
      {update.error ? <p className="error">{errorText(update.error)}</p> : null}
    </form>
  )
}

function Conflicts({ detail: d }: { detail: Detail }) {
  const trpc = useTRPC()
  const can = useCan()
  const queryClient = useQueryClient()
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: trpc.engagements.get.queryKey({ id: d.engagement.id }) })
    await queryClient.invalidateQueries({ queryKey: trpc.seasons.dashboard.queryKey({ id: d.production.seasonId }) })
  }
  const add = useMutation(trpc.engagements.addConflict.mutationOptions({ onSuccess: refresh }))
  const remove = useMutation(trpc.engagements.removeConflict.mutationOptions({ onSuccess: refresh }))
  const form = useForm({
    defaultValues: { startsOn: '', endsOn: '', description: '' },
    onSubmit: async ({ value, formApi }) => {
      await add.mutateAsync({ engagementId: d.engagement.id, ...value })
      formApi.reset()
    },
  })
  const editable = can('general', 'edit')

  return (
    <section className="card wide">
      <h2>Conflicts</h2>
      {d.conflicts.length ? (
        <ul className="plain">
          {d.conflicts.map((c) => (
            <li key={c.id}>
              {formatDate(c.startsOn)}
              {c.endsOn !== c.startsOn ? ` to ${formatDate(c.endsOn)}` : ''}: {c.description}{' '}
              {editable ? (
                <button
                  type="button"
                  className="link"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate({ id: c.id })}
                >
                  Remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">None.</p>
      )}
      {editable ? (
        <form
          className="grid conflict-row"
          onSubmit={(ev) => {
            ev.preventDefault()
            void form.handleSubmit()
          }}
        >
          <form.Field name="startsOn" validators={{ onSubmit: required }}>
            {(f) => <TextInput field={f} type="date" label="From" />}
          </form.Field>
          <form.Field name="endsOn" validators={{ onSubmit: required }}>
            {(f) => <TextInput field={f} type="date" label="To" />}
          </form.Field>
          <form.Field name="description" validators={{ onSubmit: required }}>
            {(f) => <TextInput field={f} label="What" />}
          </form.Field>
          <button type="submit" className="secondary" disabled={add.isPending}>
            Add conflict
          </button>
        </form>
      ) : null}
      {(add.error ?? remove.error) ? <p className="error">{errorText(add.error ?? remove.error)}</p> : null}
    </section>
  )
}

function RemoveButton({ detail: d }: { detail: Detail }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const remove = useMutation(trpc.engagements.remove.mutationOptions())
  async function onClick() {
    const ok = window.confirm(
      `Take ${displayName(d.person)} off ${d.production.title}? Their deal and conflicts for this production are deleted. Their profile stays.`,
    )
    if (!ok) return
    await remove.mutateAsync({ id: d.engagement.id })
    await queryClient.invalidateQueries({ queryKey: trpc.seasons.dashboard.queryKey({ id: d.production.seasonId }) })
    await navigate(`/seasons/${d.production.seasonId}`)
  }
  return (
    <p>
      <button type="button" className="danger" disabled={remove.isPending} onClick={() => void onClick()}>
        Remove from this production
      </button>
      {remove.error ? <span className="error"> {errorText(remove.error)}</span> : null}
    </p>
  )
}
