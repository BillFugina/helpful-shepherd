import { useForm } from '@tanstack/react-form'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router'
import { isMasked, type MaskedPersonField } from '../../shared/access'
import { CONTRACT_TYPE_LABELS, PIPELINE_LABELS } from '../../shared/roster'
import { required } from '../components/TermsFields'
import { errorText } from '../lib/errors'
import { displayName, TextInput, useCan } from '../lib/fields'
import { useTRPC } from '../lib/trpc'
import type { Outputs } from '../lib/types'

type PersonDetail = Outputs['people']['get']

const MASKED: { key: MaskedPersonField; label: string; type?: 'date' }[] = [
  { key: 'dob', label: 'Date of birth', type: 'date' },
  { key: 'tsaKtn', label: 'TSA PreCheck / Known Traveler number' },
  { key: 'frequentFlyer', label: 'Frequent flyer number' },
]

/** One person's profile, and every production they've been on. */
export function PersonPage() {
  const { personId = '' } = useParams()
  const trpc = useTRPC()
  const detail = useQuery(trpc.people.get.queryOptions({ id: personId }))

  if (detail.isPending) return <p className="muted">Loading…</p>
  if (detail.error) return <p className="error">{errorText(detail.error)}</p>
  const d = detail.data

  return (
    <section>
      <p className="crumbs">
        <Link to="/people">People</Link>
      </p>
      <h1>{displayName(d.person)}</h1>
      <Profile detail={d} />
      <section className="card wide">
        <h2>Productions</h2>
        {d.engagements.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Season</th>
                  <th>Production</th>
                  <th>Role</th>
                  <th>Contract</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {d.engagements.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <Link to={`/seasons/${e.seasonId}`}>{e.seasonName}</Link>
                    </td>
                    <td>{e.productionTitle}</td>
                    <td>
                      <Link to={`/engagements/${e.id}`}>{e.role ?? 'Open'}</Link>
                    </td>
                    <td>{e.contractType ? CONTRACT_TYPE_LABELS[e.contractType] : '–'}</td>
                    <td>
                      {e.pipelineStatus ? (
                        <span className={`chip status-${e.pipelineStatus}`}>{PIPELINE_LABELS[e.pipelineStatus]}</span>
                      ) : (
                        '–'
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">Not on any production yet.</p>
        )}
      </section>
    </section>
  )
}

/**
 * Plain fields edit in place. Masked fields (ID and travel numbers) never come
 * back to the browser, so they show only whether a value is on file; typing a
 * new one replaces it.
 */
function Profile({ detail: d }: { detail: PersonDetail }) {
  const trpc = useTRPC()
  const can = useCan()
  const queryClient = useQueryClient()
  const update = useMutation(trpc.people.update.mutationOptions())
  const p = d.person
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  const editGeneral = can('general', 'edit')
  const editContact = can('contact', 'edit')
  const editableMasked = MASKED.filter((m) => can(m.key === 'dob' ? 'personal_id' : 'travel_id', 'edit'))

  const form = useForm({
    defaultValues: {
      legalName: str(p.legalName),
      preferredName: str(p.preferredName),
      email: str(p.email),
      cell: str(p.cell),
      homeAirport: str(p.homeAirport),
      airportPrefs: str(p.airportPrefs),
      dob: '',
      tsaKtn: '',
      frequentFlyer: '',
    },
    onSubmit: async ({ value, formApi }) => {
      const orNull = (s: string) => (s.trim() ? s.trim() : null)
      const masked = Object.fromEntries(
        editableMasked.filter((m) => value[m.key].trim()).map((m) => [m.key, value[m.key].trim()]),
      )
      await update.mutateAsync({
        id: d.person.id,
        ...(editGeneral ? { legalName: value.legalName.trim(), preferredName: orNull(value.preferredName) } : {}),
        ...(editContact
          ? {
              email: orNull(value.email),
              cell: orNull(value.cell),
              homeAirport: orNull(value.homeAirport.toUpperCase()),
              airportPrefs: orNull(value.airportPrefs),
            }
          : {}),
        ...masked,
      })
      formApi.reset({ ...value, dob: '', tsaKtn: '', frequentFlyer: '' })
      await queryClient.invalidateQueries({ queryKey: trpc.people.get.queryKey({ id: d.person.id }) })
      await queryClient.invalidateQueries({ queryKey: trpc.people.list.queryKey() })
    },
  })

  const anyEdit = editGeneral || editContact || editableMasked.length > 0

  return (
    <form
      className="card wide"
      onSubmit={(e) => {
        e.preventDefault()
        void form.handleSubmit()
      }}
    >
      <h2>Profile</h2>
      <fieldset className="grid" disabled={!anyEdit}>
        {'legalName' in p ? (
          <>
            <form.Field name="legalName" validators={{ onChange: required }}>
              {(f) => <TextInput field={f} label="Legal name, as on their ID" readOnly={!editGeneral} />}
            </form.Field>
            <form.Field name="preferredName">
              {(f) => <TextInput field={f} label="Preferred name" readOnly={!editGeneral} />}
            </form.Field>
          </>
        ) : null}
        {'email' in p ? (
          <>
            <form.Field name="email">
              {(f) => <TextInput field={f} type="email" label="Email" readOnly={!editContact} />}
            </form.Field>
            <form.Field name="cell">
              {(f) => <TextInput field={f} type="tel" label="Cell" readOnly={!editContact} />}
            </form.Field>
            <form.Field name="homeAirport">
              {(f) => <TextInput field={f} label="Home airport" maxLength={8} readOnly={!editContact} />}
            </form.Field>
            <form.Field name="airportPrefs">
              {(f) => (
                <TextInput
                  field={f}
                  label="Airport preferences"
                  placeholder="e.g. also flies from EWR"
                  readOnly={!editContact}
                />
              )}
            </form.Field>
          </>
        ) : null}
        {MASKED.filter((m) => isMasked(p[m.key])).map((m) => {
          const v = p[m.key]
          const onFile = isMasked(v) && v.hasValue
          const editable = editableMasked.includes(m)
          return editable ? (
            <form.Field key={m.key} name={m.key}>
              {(f) => (
                <TextInput
                  field={f}
                  type={m.type ?? 'text'}
                  label={m.label}
                  placeholder={onFile ? 'On file. Type to replace' : 'Not on file'}
                  autoComplete="off"
                  hint={onFile ? 'On file. Reveal it from the People list; every view is logged.' : undefined}
                />
              )}
            </form.Field>
          ) : (
            <label key={m.key}>
              {m.label}
              <input readOnly value={onFile ? 'On file' : 'Not on file'} />
            </label>
          )
        })}
      </fieldset>
      {anyEdit ? (
        <div className="actions">
          <form.Subscribe selector={(s) => [s.isSubmitting, s.isDirty] as const}>
            {([submitting, dirty]) => (
              <button type="submit" disabled={submitting || !dirty}>
                {submitting ? 'Saving…' : 'Save profile'}
              </button>
            )}
          </form.Subscribe>
          {update.isSuccess ? <span className="muted">Saved.</span> : null}
        </div>
      ) : null}
      {update.error ? <p className="error">{errorText(update.error)}</p> : null}
    </form>
  )
}
