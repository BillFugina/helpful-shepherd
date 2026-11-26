import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { addDays, localDate } from '../../shared/time'
import { HOUSING_KIND_LABELS, HOUSING_KINDS, nightsIn, type HousingKind } from '../../shared/travel'
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
      <Warnings occupancy={occupancy.data} />
      <Calendar units={units.data} occupancy={occupancy.data} />
      <Places units={units.data} />
    </section>
  )
}

function Warnings({ occupancy }: { occupancy: Occupancy }) {
  if (!occupancy.warnings.length) return null
  const engagementOf = new Map(occupancy.stays.map((s) => [s.assignmentId, s.engagementId]))
  return (
    <div className="card wide">
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
  const edit = can('housing_access', 'edit')
  return (
    <>
      <h2>Places</h2>
      <div className="cards">
        {units.map((u) => (
          <PlaceCard key={u.id} unit={u} edit={edit} />
        ))}
      </div>
      {edit ? <NewPlace /> : null}
    </>
  )
}

function useRefreshHousing() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  return async () => {
    await queryClient.invalidateQueries({ queryKey: trpc.housing.units.queryKey() })
    await queryClient.invalidateQueries({ queryKey: trpc.housing.occupancy.pathKey() })
  }
}

function PlaceCard({ unit: u, edit }: { unit: Unit; edit: boolean }) {
  const trpc = useTRPC()
  const refresh = useRefreshHousing()
  const [room, setRoom] = useState({ name: '', floor: '1', bathroom: '' })
  const addRoom = useMutation(trpc.housing.addRoom.mutationOptions())
  const removeRoom = useMutation(trpc.housing.removeRoom.mutationOptions())
  const removeUnit = useMutation(trpc.housing.removeUnit.mutationOptions())
  const error = addRoom.error ?? removeRoom.error ?? removeUnit.error

  return (
    <div className="card">
      <div className="card-title">{u.name}</div>
      <p className="small muted">
        {u.kind ? HOUSING_KIND_LABELS[u.kind] : null}
        {u.address ? ` · ${u.address}` : ''}
      </p>
      {u.doorCode ? <p className="small">Door code {u.doorCode}</p> : null}
      {u.accessNotes ? <p className="small">{u.accessNotes}</p> : null}
      <ul className="plain small">
        {u.rooms.map((r) => (
          <li key={r.id}>
            {r.name}, floor {r.floor}, {r.bathroom}{' '}
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
        ))}
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

function NewPlace() {
  const trpc = useTRPC()
  const refresh = useRefreshHousing()
  const empty = { name: '', kind: 'apartment' as HousingKind, address: '', doorCode: '', accessNotes: '' }
  const [draft, setDraft] = useState(empty)
  const create = useMutation(trpc.housing.createUnit.mutationOptions())
  return (
    <form
      className="card wide"
      onSubmit={(ev) => {
        ev.preventDefault()
        void create
          .mutateAsync(draft)
          .then(() => setDraft(empty))
          .then(refresh)
          .catch(() => undefined)
      }}
    >
      <h2>Add a place</h2>
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
        <label>
          Address
          <input value={draft.address} onChange={(e) => setDraft({ ...draft, address: e.target.value })} />
        </label>
        <label>
          Door code
          <input value={draft.doorCode} onChange={(e) => setDraft({ ...draft, doorCode: e.target.value })} />
        </label>
        <label className="span-all">
          Getting in
          <textarea
            rows={2}
            value={draft.accessNotes}
            onChange={(e) => setDraft({ ...draft, accessNotes: e.target.value })}
          />
        </label>
      </div>
      {create.error ? <p className="error">{errorText(create.error)}</p> : null}
      <button type="submit" disabled={create.isPending}>
        Add place
      </button>
      <p className="muted small">Add rooms on the place's card once it's saved.</p>
    </form>
  )
}
