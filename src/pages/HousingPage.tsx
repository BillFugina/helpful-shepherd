import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { addDays, localDate } from '../../shared/time'
import {
  COVERAGE_STATUS_LABELS,
  HOUSING_KIND_LABELS,
  HOUSING_KINDS,
  nightRangeText,
  nightsIn,
  type HousingCoverage,
  type HousingKind,
  type HousingNeed,
} from '../../shared/travel'
import { errorText } from '../lib/errors'
import { formatDate, useCan } from '../lib/fields'
import { THEATRE_TZ } from '../lib/travel'
import { useTRPC } from '../lib/trpc'
import type { Outputs } from '../lib/types'

type Unit = Outputs['housing']['units'][number]
type Occupancy = Outputs['housing']['occupancy']

const DAYS = 28

/** Every place and room, and who sleeps where each night. */
export function HousingPage() {
  const trpc = useTRPC()
  const [params, setParams] = useSearchParams()
  const from = params.get('from') ?? localDate(new Date(), THEATRE_TZ)
  const units = useQuery(trpc.housing.units.queryOptions())
  const occupancy = useQuery(trpc.housing.occupancy.queryOptions({ from, days: DAYS }))
  const go = (d: string) => setParams({ from: d })

  const error = units.error ?? occupancy.error
  if (error) return <p className="error">{errorText(error)}</p>
  if (!units.data || !occupancy.data) return <p className="muted">Loading…</p>

  return (
    <section>
      <div className="title-row">
        <h1>Housing</h1>
        <div className="actions">
          <button type="button" className="secondary" onClick={() => go(addDays(from, -DAYS))}>
            Earlier
          </button>
          <strong>
            {formatDate(from)} to {formatDate(addDays(from, DAYS - 1))}
          </strong>
          <button type="button" className="secondary" onClick={() => go(addDays(from, DAYS))}>
            Later
          </button>
        </div>
      </div>
      {!occupancy.data.stays.length && occupancy.data.nextStayFrom ? (
        <p>
          No one is housed in these four weeks.{' '}
          <button type="button" className="link" onClick={() => go(occupancy.data.nextStayFrom!)}>
            Jump to the next stay, {formatDate(occupancy.data.nextStayFrom)}
          </button>
        </p>
      ) : null}
      <StillNeeds />
      <Warnings occupancy={occupancy.data} />
      <Moves units={units.data} occupancy={occupancy.data} />
      <Calendar units={units.data} occupancy={occupancy.data} />
      <Places units={units.data} />
    </section>
  )
}

/** What a person is still missing, in a few words. */
export function coverageText(coverage: HousingCoverage, need: HousingNeed | null): string {
  if (coverage.status === 'no_dates') return 'no dates to go on yet; add their flights or the dates they asked for'
  if (coverage.status === 'unhoused' && need) return `needs a room, ${formatDate(need.from)} to ${formatDate(need.to)}`
  if (coverage.status === 'partly_housed')
    return `missing the ${coverage.missing.map(nightRangeText).join(' and the ')}`
  return ''
}

/** Everyone on a production that hasn't closed who still needs a room, nights or dates. */
function StillNeeds() {
  const trpc = useTRPC()
  const needs = useQuery(trpc.housing.needs.queryOptions())
  if (needs.error) return <p className="error small">{errorText(needs.error)}</p>
  if (!needs.data) return null
  const { people, productions } = needs.data
  return (
    <div className="card wide">
      <h2>Still needs housing</h2>
      {people.length ? (
        <ul className="plain">
          {people.map((p) => (
            <li key={p.engagementId}>
              <Link to={`/engagements/${p.engagementId}/travel`}>{p.name}</Link>{' '}
              <span className="muted small">
                {p.role}, {p.productionTitle}
              </span>
              : {coverageText(p.coverage, p.need)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Everyone on an open production whose deal includes housing has a room for every night.</p>
      )}
      {productions.length ? (
        <p className="small">
          Plan by production:{' '}
          {productions.map((p, i) => (
            <span key={p.id}>
              {i ? ' · ' : ''}
              <Link to={`/housing/plan?production=${p.id}`}>{p.title}</Link>
            </span>
          ))}
        </p>
      ) : null}
    </div>
  )
}

/** Move-ins and move-outs in the window, with rooms that turn over the same day marked. */
function Moves({ units, occupancy }: { units: Unit[]; occupancy: Occupancy }) {
  if (!occupancy.moves.length) return null
  const roomLabel = new Map(units.flatMap((u) => u.rooms.map((r) => [r.id, `${u.name}, ${r.name}`] as const)))
  return (
    <div className="card wide">
      <h2>Moving in and out</h2>
      <ul className="plain">
        {occupancy.moves.map((m) => (
          <li key={`${m.assignmentId}-${m.kind}`}>
            <strong>{formatDate(m.date)}</strong>:{' '}
            <Link to={`/engagements/${m.engagementId}/travel`}>{m.personName}</Link>{' '}
            {m.kind === 'in' ? 'moves into' : 'moves out of'} {roomLabel.get(m.roomId) ?? 'a room'}
            {m.turnover ? <span className="warning small"> · same-day turnover, clean between stays</span> : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

function Warnings({ occupancy }: { occupancy: Occupancy }) {
  if (!occupancy.warnings.length) return null
  const engagementOf = new Map(occupancy.stays.map((s) => [s.assignmentId, s.engagementId]))
  return (
    <div className="card wide" data-tour="housing-check">
      <h2>Check these</h2>
      <ul className="plain">
        {occupancy.warnings.map((w) => (
          <li key={`${w.assignmentId}-${w.kind}`} className="warning">
            {w.message} <Link to={`/engagements/${engagementOf.get(w.assignmentId)}/travel`}>Open</Link>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Calendar({ units, occupancy }: { units: Unit[]; occupancy: Occupancy }) {
  const nights = Array.from({ length: occupancy.days }, (_, i) => addDays(occupancy.from, i))
  const warned = new Set(occupancy.warnings.map((w) => w.assignmentId))
  return (
    <div className="table-wrap card wide calendar">
      <table>
        <thead>
          <tr>
            <th>Room</th>
            {nights.map((n) => (
              <th key={n} className="night">
                {Number(n.slice(8))}
                {n.slice(8) === '01' || n === occupancy.from ? (
                  <div className="muted small">
                    {new Date(`${n}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })}
                  </div>
                ) : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {units.flatMap((u) =>
            u.rooms.map((r) => {
              const stays = occupancy.stays.filter((s) => s.roomId === r.id)
              const cells: React.ReactNode[] = []
              for (let i = 0; i < nights.length;) {
                const stay = stays.find((s) => nightsIn(s, nights[i]!, 1).length)
                if (!stay) {
                  cells.push(<td key={i} className="night" />)
                  i++
                  continue
                }
                const span = nightsIn(stay, nights[i]!, nights.length - i).length
                cells.push(
                  <td key={i} colSpan={span} className={`stay${warned.has(stay.assignmentId) ? ' warned' : ''}`}>
                    <Link to={`/engagements/${stay.engagementId}/travel`} title={stay.personName}>
                      {stay.personName}
                    </Link>
                  </td>,
                )
                i += span
              }
              return (
                <tr key={r.id}>
                  <th scope="row" className="room">
                    {u.name}
                    <div className="muted small">
                      {r.name} · floor {r.floor}
                    </div>
                  </th>
                  {cells}
                </tr>
              )
            }),
          )}
        </tbody>
      </table>
    </div>
  )
}

function Places({ units }: { units: Unit[] }) {
  const can = useCan()
  const edit = can('housing', 'edit')
  const editAccess = can('housing_access', 'edit')
  return (
    <>
      <h2>Places</h2>
      <div className="cards">
        {units.map((u) => (
          <PlaceCard key={u.id} unit={u} edit={edit} editAccess={editAccess} />
        ))}
      </div>
      {edit ? <NewPlace editAccess={editAccess} /> : null}
    </>
  )
}

function useRefreshHousing() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  return async () => {
    await queryClient.invalidateQueries({ queryKey: trpc.housing.units.queryKey() })
    await queryClient.invalidateQueries({ queryKey: trpc.housing.occupancy.pathKey() })
    await queryClient.invalidateQueries({ queryKey: trpc.housing.needs.queryKey() })
    await queryClient.invalidateQueries({ queryKey: trpc.housing.plan.pathKey() })
  }
}

function PlaceCard({ unit: u, edit, editAccess }: { unit: Unit; edit: boolean; editAccess: boolean }) {
  const trpc = useTRPC()
  const refresh = useRefreshHousing()
  const [editing, setEditing] = useState(false)
  const [editingRoom, setEditingRoom] = useState<string | null>(null)
  const [room, setRoom] = useState({ name: '', floor: '1', bathroom: '' })
  const addRoom = useMutation(trpc.housing.addRoom.mutationOptions())
  const removeRoom = useMutation(trpc.housing.removeRoom.mutationOptions())
  const removeUnit = useMutation(trpc.housing.removeUnit.mutationOptions())
  const error = addRoom.error ?? removeRoom.error ?? removeUnit.error

  if (editing) {
    return (
      <div className="card">
        <EditPlace unit={u} editAccess={editAccess} onDone={() => setEditing(false)} />
      </div>
    )
  }

  return (
    <div className="card">
      <div className="card-title">{u.name}</div>
      <p className="small muted">
        {u.kind ? HOUSING_KIND_LABELS[u.kind] : null}
        {u.address ? ` · ${u.address}` : ''}
      </p>
      {u.doorCode ? <p className="small">Door code {u.doorCode}</p> : null}
      {u.accessNotes ? <p className="small">{u.accessNotes}</p> : null}
      {u.notes ? <p className="small muted">{u.notes}</p> : null}
      {edit ? (
        <button type="button" className="link" onClick={() => setEditing(true)}>
          Edit this place
        </button>
      ) : null}
      <ul className="plain small">
        {u.rooms.map((r) =>
          editingRoom === r.id ? (
            <li key={r.id}>
              <EditRoom room={r} onDone={() => setEditingRoom(null)} />
            </li>
          ) : (
            <li key={r.id}>
              {r.name}, floor {r.floor}, {r.bathroom}{' '}
              {edit ? (
                <button type="button" className="link" onClick={() => setEditingRoom(r.id!)}>
                  Edit
                </button>
              ) : null}{' '}
              {edit ? (
                <button
                  type="button"
                  className="link"
                  disabled={removeRoom.isPending}
                  onClick={() =>
                    void removeRoom
                      .mutateAsync({ id: r.id! })
                      .then(refresh)
                      .catch(() => undefined)
                  }
                >
                  Remove
                </button>
              ) : null}
            </li>
          ),
        )}
      </ul>
      {edit ? (
        <form
          className="room-form"
          onSubmit={(ev) => {
            ev.preventDefault()
            void addRoom
              .mutateAsync({ unitId: u.id!, name: room.name, floor: Number(room.floor), bathroom: room.bathroom })
              .then(() => setRoom({ name: '', floor: '1', bathroom: '' }))
              .then(refresh)
              .catch(() => undefined)
          }}
        >
          <input
            aria-label="Room name"
            placeholder="Room name"
            required
            value={room.name}
            onChange={(e) => setRoom({ ...room, name: e.target.value })}
          />
          <input
            aria-label="Floor"
            type="number"
            min={0}
            max={50}
            value={room.floor}
            onChange={(e) => setRoom({ ...room, floor: e.target.value })}
          />
          <input
            aria-label="Bathroom"
            placeholder="Bathroom, like Upstairs bath"
            required
            value={room.bathroom}
            onChange={(e) => setRoom({ ...room, bathroom: e.target.value })}
          />
          <button type="submit" className="secondary" disabled={addRoom.isPending}>
            Add room
          </button>
        </form>
      ) : null}
      {error ? <p className="error small">{errorText(error)}</p> : null}
      {edit ? (
        <button
          type="button"
          className="link danger"
          disabled={removeUnit.isPending}
          onClick={() => {
            if (!confirm(`Remove ${u.name} and its rooms?`)) return
            void removeUnit
              .mutateAsync({ id: u.id! })
              .then(refresh)
              .catch(() => undefined)
          }}
        >
          Remove this place
        </button>
      ) : null}
    </div>
  )
}

function NewPlace({ editAccess }: { editAccess: boolean }) {
  const trpc = useTRPC()
  const refresh = useRefreshHousing()
  const empty = { name: '', kind: 'apartment' as HousingKind, address: '', doorCode: '', accessNotes: '', notes: '' }
  const [draft, setDraft] = useState(empty)
  const create = useMutation(trpc.housing.createUnit.mutationOptions())
  return (
    <form
      className="card wide"
      onSubmit={(ev) => {
        ev.preventDefault()
        void create
          .mutateAsync(editAccess ? draft : { name: draft.name, kind: draft.kind })
          .then(() => setDraft(empty))
          .then(refresh)
          .catch(() => undefined)
      }}
    >
      <h2>Add a place</h2>
      <div className="grid">
        <label>
          Name
          <input
            value={draft.name}
            required
            placeholder="Like Oak Street house"
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
        <label>
          Kind
          <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as HousingKind })}>
            {HOUSING_KINDS.map((k) => (
              <option key={k} value={k}>
                {HOUSING_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        {editAccess ? <AccessFields value={draft} onChange={(v) => setDraft({ ...draft, ...v })} /> : null}
      </div>
      {create.error ? <p className="error">{errorText(create.error)}</p> : null}
      <button type="submit" disabled={create.isPending}>
        Add place
      </button>
      <p className="muted small">
        Name the place with a label, not its address: anyone who can see housing sees the name, and only people with
        housing access see the address and how to get in. Add rooms on the place's card once it's saved.
      </p>
    </form>
  )
}

type AccessDraft = { address: string; doorCode: string; accessNotes: string; notes: string }

/** Address, door code, getting in and notes: only shown to people who can edit housing access. */
function AccessFields({ value, onChange }: { value: AccessDraft; onChange: (v: Partial<AccessDraft>) => void }) {
  return (
    <>
      <label>
        Address
        <input value={value.address} onChange={(e) => onChange({ address: e.target.value })} />
      </label>
      <label>
        Door code
        <input value={value.doorCode} onChange={(e) => onChange({ doorCode: e.target.value })} />
      </label>
      <label className="span-all">
        Getting in
        <textarea rows={2} value={value.accessNotes} onChange={(e) => onChange({ accessNotes: e.target.value })} />
      </label>
      <label className="span-all">
        Notes
        <textarea rows={2} value={value.notes} onChange={(e) => onChange({ notes: e.target.value })} />
      </label>
    </>
  )
}

function EditPlace({ unit: u, editAccess, onDone }: { unit: Unit; editAccess: boolean; onDone: () => void }) {
  const trpc = useTRPC()
  const refresh = useRefreshHousing()
  const [draft, setDraft] = useState({
    name: u.name ?? '',
    kind: (u.kind ?? 'apartment') as HousingKind,
    address: u.address ?? '',
    doorCode: u.doorCode ?? '',
    accessNotes: u.accessNotes ?? '',
    notes: u.notes ?? '',
  })
  const update = useMutation(trpc.housing.updateUnit.mutationOptions())
  return (
    <form
      onSubmit={(ev) => {
        ev.preventDefault()
        const access = editAccess
          ? { address: draft.address, doorCode: draft.doorCode, accessNotes: draft.accessNotes, notes: draft.notes }
          : {}
        void update
          .mutateAsync({ id: u.id!, name: draft.name, kind: draft.kind, ...access })
          .then(refresh)
          .then(onDone)
          .catch(() => undefined)
      }}
    >
      <div className="grid">
        <label>
          Name
          <input value={draft.name} required onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        </label>
        <label>
          Kind
          <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as HousingKind })}>
            {HOUSING_KINDS.map((k) => (
              <option key={k} value={k}>
                {HOUSING_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        {editAccess ? <AccessFields value={draft} onChange={(v) => setDraft({ ...draft, ...v })} /> : null}
      </div>
      {update.error ? <p className="error small">{errorText(update.error)}</p> : null}
      <div className="actions">
        <button type="submit" disabled={update.isPending}>
          Save
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function EditRoom({ room: r, onDone }: { room: Unit['rooms'][number]; onDone: () => void }) {
  const trpc = useTRPC()
  const refresh = useRefreshHousing()
  const [draft, setDraft] = useState({ name: r.name ?? '', floor: String(r.floor ?? 1), bathroom: r.bathroom ?? '' })
  const update = useMutation(trpc.housing.updateRoom.mutationOptions())
  return (
    <form
      className="room-form"
      onSubmit={(ev) => {
        ev.preventDefault()
        void update
          .mutateAsync({ id: r.id!, name: draft.name, floor: Number(draft.floor), bathroom: draft.bathroom })
          .then(refresh)
          .then(onDone)
          .catch(() => undefined)
      }}
    >
      <input
        aria-label="Room name"
        required
        value={draft.name}
        onChange={(e) => setDraft({ ...draft, name: e.target.value })}
      />
      <input
        aria-label="Floor"
        type="number"
        min={0}
        max={50}
        value={draft.floor}
        onChange={(e) => setDraft({ ...draft, floor: e.target.value })}
      />
      <input
        aria-label="Bathroom"
        required
        value={draft.bathroom}
        onChange={(e) => setDraft({ ...draft, bathroom: e.target.value })}
      />
      <button type="submit" className="secondary" disabled={update.isPending}>
        Save
      </button>
      <button type="button" className="link" onClick={onDone}>
        Cancel
      </button>
      {update.error ? <span className="error small">{errorText(update.error)}</span> : null}
    </form>
  )
}

const NEED_SOURCE_TEXT = {
  flights: 'from their flights',
  preferred: 'from the dates they asked for',
  production: 'from the production dates',
} as const

/** One production: where each person stays, the nights they need, and what's still missing. */
export function HousingPlanPage() {
  const trpc = useTRPC()
  const [params, setParams] = useSearchParams()
  const productions = useQuery(trpc.productions.list.queryOptions())
  const chosen = params.get('production') ?? ''
  const plan = useQuery({ ...trpc.housing.plan.queryOptions({ productionId: chosen }), enabled: Boolean(chosen) })

  if (productions.error) return <p className="error">{errorText(productions.error)}</p>
  if (!productions.data) return <p className="muted">Loading…</p>

  return (
    <section>
      <div className="title-row">
        <h1>Housing plan</h1>
        <div className="actions">
          <select
            aria-label="Production"
            value={chosen}
            onChange={(e) => setParams(e.target.value ? { production: e.target.value } : {})}
          >
            <option value="">Pick a production</option>
            {productions.data.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title} ({p.seasonName})
              </option>
            ))}
          </select>
          <Link to="/housing">Housing calendar</Link>
        </div>
      </div>
      {!chosen ? <p className="muted">Pick a production to see where everyone stays.</p> : null}
      {plan.error ? <p className="error">{errorText(plan.error)}</p> : null}
      {chosen && !plan.data && !plan.error ? <p className="muted">Loading…</p> : null}
      {plan.data ? <PlanTable plan={plan.data} /> : null}
    </section>
  )
}

function PlanTable({ plan }: { plan: Outputs['housing']['plan'] }) {
  const { counts, people, production } = plan
  const open = counts.unhoused + counts.partlyHoused + counts.noDates
  return (
    <>
      <p>
        {production.rehearsalStart && production.closing
          ? `Rehearsals start ${formatDate(production.rehearsalStart)}, closing ${formatDate(production.closing)}. `
          : ''}
        {open
          ? `${open} ${open === 1 ? 'person needs' : 'people need'} something: ${counts.unhoused} with no room, ${counts.partlyHoused} missing nights, ${counts.noDates} with no dates.`
          : 'Everyone whose deal includes housing has a room for every night.'}{' '}
        <span className="muted">
          {counts.housed} housed, {counts.notProvided} without housing in their deal.
        </span>
      </p>
      <div className="table-wrap card wide">
        <table>
          <thead>
            <tr>
              <th>Person</th>
              <th>Status</th>
              <th>Nights needed</th>
              <th>Where they stay</th>
            </tr>
          </thead>
          <tbody>
            {people.map((p) => (
              <tr key={p.engagementId}>
                <td>
                  <Link to={`/engagements/${p.engagementId}/travel`}>{p.name}</Link>
                  <div className="muted small">{p.role}</div>
                </td>
                <td className={needsWork(p.coverage.status) ? 'warning' : undefined}>
                  {COVERAGE_STATUS_LABELS[p.coverage.status]}
                  {p.coverage.status === 'partly_housed' ? (
                    <div className="small">{p.coverage.missing.map(nightRangeText).join(', ')}</div>
                  ) : null}
                </td>
                <td className="small">
                  {p.need ? (
                    <>
                      {formatDate(p.need.from)} to {formatDate(p.need.to)}
                      <div className="muted">{NEED_SOURCE_TEXT[p.need.source]}</div>
                    </>
                  ) : (
                    <span className="muted">{p.housingProvided ? 'No dates yet' : 'Not needed'}</span>
                  )}
                </td>
                <td className="small">
                  {p.stays.map((s) => (
                    <div key={s.assignmentId}>
                      {s.unitName}, {s.roomName}: {formatDate(s.startsOn)} to {formatDate(s.endsOn)}
                    </div>
                  ))}
                  {p.warnings.map((w) => (
                    <div key={w} className="warning">
                      {w}
                    </div>
                  ))}
                  {needsWork(p.coverage.status) ? (
                    <Link to={`/engagements/${p.engagementId}/travel`}>Assign a room</Link>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

const needsWork = (s: HousingCoverage['status']) => s === 'unhoused' || s === 'partly_housed' || s === 'no_dates'
