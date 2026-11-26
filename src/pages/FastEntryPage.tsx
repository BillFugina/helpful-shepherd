import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { TermsFields, required, type HasField } from '../components/TermsFields'
import { errorText } from '../lib/errors'
import {
  displayName,
  draftFromEngagement,
  EMPTY_TERMS,
  formatDate,
  termsFromDraft,
  TextInput,
  useCan,
  type TermsDraft,
} from '../lib/fields'
import { useTRPC, type RouterOutputs } from '../lib/trpc'

interface ConflictDraft {
  startsOn: string
  endsOn: string
  description: string
}

interface Values {
  personMode: 'existing' | 'new'
  personId: string
  personLabel: string
  person: { legalName: string; preferredName: string; email: string; cell: string; homeAirport: string }
  agentMode: 'none' | 'existing' | 'new'
  agentId: string
  agent: { name: string; agency: string; email: string; phone: string }
  terms: TermsDraft
  conflicts: ConflictDraft[]
}

const DEFAULTS: Values = {
  personMode: 'new',
  personId: '',
  personLabel: '',
  person: { legalName: '', preferredName: '', email: '', cell: '', homeAirport: '' },
  agentMode: 'none',
  agentId: '',
  agent: { name: '', agency: '', email: '', phone: '' },
  terms: EMPTY_TERMS,
  conflicts: [],
}

const orNull = (s: string) => (s.trim() ? s.trim() : null)

type Draft = RouterOutputs['drafts']['get']

/** Form values from a connector draft, for the Company Manager to check and save. */
function valuesFromDraft(d: Draft): Values {
  return {
    personMode: d.matchedPerson ? 'existing' : 'new',
    personId: d.matchedPerson?.id ?? '',
    personLabel: d.matchedPerson?.legalName ?? '',
    person: {
      legalName: d.person.legalName,
      preferredName: d.person.preferredName ?? '',
      email: d.person.email ?? '',
      cell: d.person.cell ?? '',
      homeAirport: d.person.homeAirport ?? '',
    },
    agentMode: d.matchedAgentId ? 'existing' : d.agent ? 'new' : 'none',
    agentId: d.matchedAgentId ?? '',
    agent: {
      name: d.agent?.name ?? '',
      agency: d.agent?.agency ?? '',
      email: d.agent?.email ?? '',
      phone: d.agent?.phone ?? '',
    },
    terms: draftFromEngagement(d.terms),
    conflicts: d.conflicts.map((c) => ({ startsOn: c.startsOn, endsOn: c.endsOn, description: c.description })),
  }
}

/**
 * The fast-entry form, laid out in the order of the acceptance email: who,
 * role, pay, agent and commission, travel and housing, conflicts, the rest.
 * One save writes the person, agent, deal and conflicts together. With
 * ?draft=, it opens filled in from a draft the Claude connector made, and
 * saving it is what turns the draft into a real record.
 */
export function FastEntryPage() {
  const [params] = useSearchParams()
  const draftId = params.get('draft')
  const trpc = useTRPC()
  const draft = useQuery({ ...trpc.drafts.get.queryOptions({ id: draftId ?? '' }), enabled: Boolean(draftId) })
  if (!draftId) return <FastEntryForm initial={DEFAULTS} draft={null} />
  if (draft.isPending) return <p className="muted">Loading…</p>
  if (draft.error) return <p className="error">{errorText(draft.error)}</p>
  if (draft.data.status !== 'pending') {
    return (
      <p>
        That draft was already {draft.data.status}.{' '}
        {draft.data.engagementId ? <Link to={`/engagements/${draft.data.engagementId}`}>Open the record</Link> : null}
      </p>
    )
  }
  return <FastEntryForm key={draftId} initial={valuesFromDraft(draft.data)} draft={draft.data} />
}

function FastEntryForm({ initial, draft }: { initial: Values; draft: Draft | null }) {
  const { productionId = '' } = useParams()
  const trpc = useTRPC()
  const can = useCan()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const production = useQuery(trpc.productions.get.queryOptions({ id: productionId }))
  const agents = useQuery({ ...trpc.agents.list.queryOptions(), enabled: can('contact') })
  const create = useMutation(trpc.engagements.quickCreate.mutationOptions())
  const payTerms = can('pay_terms', 'edit')

  const dismiss = useMutation(trpc.drafts.dismiss.mutationOptions())
  const form = useForm({
    defaultValues: initial,
    onSubmit: async ({ value }) => {
      const result = await create.mutateAsync({
        productionId,
        ...(draft ? { draftId: draft.id } : {}),
        person:
          value.personMode === 'existing'
            ? { kind: 'existing', personId: value.personId }
            : {
                kind: 'new',
                person: {
                  legalName: value.person.legalName.trim(),
                  preferredName: orNull(value.person.preferredName),
                  email: orNull(value.person.email),
                  cell: orNull(value.person.cell),
                  homeAirport: orNull(value.person.homeAirport.toUpperCase()),
                },
              },
        agent:
          value.agentMode === 'existing'
            ? { kind: 'existing', agentId: value.agentId }
            : value.agentMode === 'new'
              ? {
                  kind: 'new',
                  agent: {
                    name: value.agent.name.trim(),
                    agency: orNull(value.agent.agency),
                    email: orNull(value.agent.email),
                    phone: orNull(value.agent.phone),
                  },
                }
              : { kind: 'none' },
        terms: termsFromDraft(value.terms, { payTerms }),
        conflicts: value.conflicts.map((c) => ({ ...c, description: c.description.trim() })),
      })
      if (draft) await queryClient.invalidateQueries({ queryKey: trpc.drafts.list.queryKey() })
      if (production.data) {
        await queryClient.invalidateQueries({
          queryKey: trpc.seasons.dashboard.queryKey({ id: production.data.seasonId }),
        })
      }
      await navigate(`/engagements/${result.id}`)
    },
  })
  const F = form as unknown as HasField

  if (production.isPending) return <p className="muted">Loading…</p>
  if (production.error) return <p className="error">{errorText(production.error)}</p>
  if (!can('general', 'edit')) return <p>Your role can view the roster but not add to it.</p>
  const p = production.data

  return (
    <section>
      <p className="crumbs">
        <Link to={`/seasons/${p.seasonId}`}>{p.seasonName}</Link>
      </p>
      <h1>Add someone to {p.title}</h1>
      <p className="muted">
        Rehearsal {formatDate(p.rehearsalStart)} · Opens {formatDate(p.opening)} · Closes {formatDate(p.closing)}. Fill
        it in straight from the acceptance email.
      </p>
      {draft ? (
        <div className="card draft-note">
          <p>
            <strong>Draft from Claude.</strong> Check every field against the email before you save. Nothing is on the
            roster until you do.
            {draft.matchedPerson
              ? ' This looks like someone already in the app, so it will add them as returning.'
              : ''}
          </p>
          {draft.sourceText ? (
            <details>
              <summary>The acceptance email</summary>
              <pre className="source-email">{draft.sourceText}</pre>
            </details>
          ) : null}
          <button
            type="button"
            className="secondary"
            disabled={dismiss.isPending}
            onClick={async () => {
              await dismiss.mutateAsync({ id: draft.id })
              await queryClient.invalidateQueries({ queryKey: trpc.drafts.list.queryKey() })
              await navigate('/drafts')
            }}
          >
            {dismiss.isPending ? 'Dismissing…' : 'Dismiss this draft'}
          </button>
          {dismiss.error ? <span className="error">{errorText(dismiss.error)}</span> : null}
        </div>
      ) : null}
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          void form.handleSubmit()
        }}
      >
        <fieldset>
          <legend>Who</legend>
          <form.Subscribe selector={(s) => [s.values.personMode, s.values.personLabel] as const}>
            {([mode, label]) =>
              mode === 'existing' ? (
                <p>
                  Returning: <strong>{label}</strong>{' '}
                  <button
                    type="button"
                    className="link"
                    onClick={() => {
                      form.setFieldValue('personMode', 'new')
                      form.setFieldValue('personId', '')
                    }}
                  >
                    Change
                  </button>
                </p>
              ) : (
                <>
                  <ReturningSearch
                    onPick={(person, latestAgent) => {
                      form.setFieldValue('personMode', 'existing')
                      form.setFieldValue('personId', person.id)
                      form.setFieldValue('personLabel', person.label)
                      if (latestAgent) {
                        form.setFieldValue('agentMode', 'existing')
                        form.setFieldValue('agentId', latestAgent)
                      }
                    }}
                  />
                  <p className="muted small">Or someone new:</p>
                  <div className="grid">
                    <form.Field
                      name="person.legalName"
                      validators={{
                        onSubmit: ({ value, fieldApi }) =>
                          fieldApi.form.getFieldValue('personMode') === 'new' && !value.trim() ? 'Required' : undefined,
                      }}
                    >
                      {(f) => <TextInput field={f} label="Legal name, as on their ID" />}
                    </form.Field>
                    <form.Field name="person.preferredName">
                      {(f) => <TextInput field={f} label="Preferred name" />}
                    </form.Field>
                    {can('contact', 'edit') ? (
                      <>
                        <form.Field name="person.email">
                          {(f) => <TextInput field={f} type="email" label="Email" />}
                        </form.Field>
                        <form.Field name="person.cell">
                          {(f) => <TextInput field={f} type="tel" label="Cell" />}
                        </form.Field>
                        <form.Field name="person.homeAirport">
                          {(f) => <TextInput field={f} label="Home airport" placeholder="LGA" maxLength={8} />}
                        </form.Field>
                      </>
                    ) : null}
                  </div>
                </>
              )
            }
          </form.Subscribe>
        </fieldset>

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

        {can('contact', 'edit') ? (
          <fieldset>
            <legend>Agent</legend>
            <form.Field name="agentMode">
              {(f) => (
                <div className="checks">
                  {(['none', 'existing', 'new'] as const).map((m) => (
                    <label key={m} className="inline">
                      <input
                        type="radio"
                        name="agentMode"
                        checked={f.state.value === m}
                        onChange={() => f.handleChange(m)}
                      />
                      {m === 'none' ? 'No agent' : m === 'existing' ? 'Agent already in the app' : 'New agent'}
                    </label>
                  ))}
                </div>
              )}
            </form.Field>
            <form.Subscribe selector={(s) => s.values.agentMode}>
              {(mode) =>
                mode === 'existing' ? (
                  <form.Field
                    name="agentId"
                    validators={{
                      onSubmit: ({ value, fieldApi }) =>
                        fieldApi.form.getFieldValue('agentMode') === 'existing' && !value ? 'Pick an agent' : undefined,
                    }}
                  >
                    {(f) => (
                      <label>
                        Agent
                        <select value={f.state.value} onChange={(e) => f.handleChange(e.target.value)}>
                          <option value="">Choose…</option>
                          {(agents.data ?? []).map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name}
                              {a.agency ? `, ${a.agency}` : ''}
                            </option>
                          ))}
                        </select>
                        {f.state.meta.errors.length ? (
                          <span className="error">{String(f.state.meta.errors[0])}</span>
                        ) : null}
                      </label>
                    )}
                  </form.Field>
                ) : mode === 'new' ? (
                  <div className="grid">
                    <form.Field
                      name="agent.name"
                      validators={{
                        onSubmit: ({ value, fieldApi }) =>
                          fieldApi.form.getFieldValue('agentMode') === 'new' && !value.trim() ? 'Required' : undefined,
                      }}
                    >
                      {(f) => <TextInput field={f} label="Agent name" />}
                    </form.Field>
                    <form.Field name="agent.agency">{(f) => <TextInput field={f} label="Agency" />}</form.Field>
                    <form.Field name="agent.email">
                      {(f) => <TextInput field={f} type="email" label="Agent email" />}
                    </form.Field>
                    <form.Field name="agent.phone">
                      {(f) => <TextInput field={f} type="tel" label="Agent phone" />}
                    </form.Field>
                  </div>
                ) : null
              }
            </form.Subscribe>
            {payTerms ? <TermsFields form={F} prefix="terms." part="commission" /> : null}
          </fieldset>
        ) : null}

        <fieldset>
          <legend>Travel and housing</legend>
          <TermsFields form={F} prefix="terms." part="logistics" />
        </fieldset>

        <fieldset>
          <legend>Conflicts</legend>
          <form.Field name="conflicts" mode="array">
            {(list) => (
              <>
                {list.state.value.map((_, i) => (
                  <div key={i} className="grid conflict-row">
                    <form.Field name={`conflicts[${i}].startsOn`} validators={{ onSubmit: required }}>
                      {(f) => <TextInput field={f} type="date" label="From" />}
                    </form.Field>
                    <form.Field name={`conflicts[${i}].endsOn`} validators={{ onSubmit: required }}>
                      {(f) => <TextInput field={f} type="date" label="To" />}
                    </form.Field>
                    <form.Field name={`conflicts[${i}].description`} validators={{ onSubmit: required }}>
                      {(f) => <TextInput field={f} label="What" />}
                    </form.Field>
                    <button type="button" className="link" onClick={() => list.removeValue(i)}>
                      Remove
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="secondary"
                  onClick={() => list.pushValue({ startsOn: '', endsOn: '', description: '' })}
                >
                  Add a conflict
                </button>
              </>
            )}
          </form.Field>
        </fieldset>

        <fieldset>
          <legend>The rest</legend>
          <TermsFields form={F} prefix="terms." part="extras" />
        </fieldset>

        <div className="actions">
          <form.Subscribe selector={(s) => s.isSubmitting}>
            {(submitting) => (
              <button type="submit" disabled={submitting}>
                {submitting ? 'Saving…' : 'Save'}
              </button>
            )}
          </form.Subscribe>
          <Link to={draft ? '/drafts' : `/seasons/${p.seasonId}`}>Cancel</Link>
        </div>
        {create.error ? <p className="error">{errorText(create.error)}</p> : null}
      </form>
    </section>
  )
}

/** Finds a returning person, so their profile and travel details aren't typed again. */
function ReturningSearch({
  onPick,
}: {
  onPick: (person: { id: string; label: string }, latestAgentId: string | null) => void
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250)
    return () => clearTimeout(t)
  }, [q])
  const results = useQuery({ ...trpc.people.search.queryOptions({ q: debounced }), enabled: debounced.length >= 2 })

  async function pick(id: string, label: string) {
    const detail = await queryClient.fetchQuery(trpc.people.get.queryOptions({ id }))
    onPick({ id, label }, detail.latestAgent?.id ?? null)
  }

  return (
    <div className="search">
      <label>
        Returning person? Search by name
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Start typing a name" />
      </label>
      {results.data?.length ? (
        <ul className="results">
          {results.data.map((r) => (
            <li key={r.id}>
              <button type="button" className="link" onClick={() => void pick(r.id, displayName(r))}>
                {displayName(r)}
              </button>
              {r.email ? <span className="muted small"> {r.email}</span> : null}
            </li>
          ))}
        </ul>
      ) : debounced.length >= 2 && results.isSuccess ? (
        <p className="muted small">No one by that name yet.</p>
      ) : null}
    </div>
  )
}
