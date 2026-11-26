import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { THEATRE_AIRPORT } from '../../shared/time'
import {
  COVERAGE_STATUS_LABELS,
  FLIGHT_DIRECTION_LABELS,
  HOUSING_RULE_LABELS,
  HOUSING_RULES,
  type FlightDirection,
  type HousingRule,
  nightRangeText,
} from '../../shared/travel'
import { errorText } from '../lib/errors'
import { displayName, formatDate, useCan } from '../lib/fields'
import { airportTz, dayAt, flightStatus, THEATRE_TZ, timeAt, utcToLocal } from '../lib/travel'
import { useTRPC } from '../lib/trpc'
import type { Outputs } from '../lib/types'

type Itinerary = Outputs['travel']['forEngagement']
type Flight = NonNullable<Itinerary['flights']>[number]
type Car = NonNullable<Itinerary['cars']>[number]

/** One person's flights, rental car and housing for one production. */
export function TravelPage() {
  const { engagementId = '' } = useParams()
  const trpc = useTRPC()
  const can = useCan()
  const it = useQuery(trpc.travel.forEngagement.queryOptions({ engagementId }))

  if (it.isPending) return <p className="muted">Loading…</p>
  if (it.error) return <p className="error">{errorText(it.error)}</p>
  const d = it.data

  return (
    <section>
      <p className="crumbs">
        <Link to={`/engagements/${engagementId}`}>
          {displayName(d.person)} · {d.production.title}
        </Link>
      </p>
      <h1>Travel and housing</h1>
      <p className="muted">
        {[
          d.role,
          d.person.homeAirport ? `Flies from ${d.person.homeAirport}` : null,
          d.preferredArrival ? `Wants to arrive ${formatDate(d.preferredArrival)}` : null,
          d.preferredDeparture ? `and leave ${formatDate(d.preferredDeparture)}` : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
      {d.person.airportPrefs ? <p className="small">Airport notes: {d.person.airportPrefs}</p> : null}

      {d.flights ? <Flights itinerary={d} /> : null}
      {d.cars ? <Cars itinerary={d} /> : null}
      {d.housing ? <Housing itinerary={d} /> : null}
      <Preferences itinerary={d} />
      {!can('travel_logistics') && !can('housing') ? (
        <p className="muted">Your role can't see travel or housing.</p>
      ) : null}
    </section>
  )
}

function useRefresh(engagementId: string) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  return async () => {
    await queryClient.invalidateQueries({ queryKey: trpc.travel.forEngagement.queryKey({ engagementId }) })
    await queryClient.invalidateQueries({ queryKey: trpc.arrivals.board.pathKey() })
    await queryClient.invalidateQueries({ queryKey: trpc.housing.occupancy.pathKey() })
  }
}

// ---------------------------------------------------------------------------
// Flights
// ---------------------------------------------------------------------------

interface FlightDraft {
  direction: FlightDirection
  airline: string
  flightNumber: string
  fromAirport: string
  toAirport: string
  departLocal: string
  arriveLocal: string
  confirmation: string
  bookingSource: string
  notes: string
}

function draftFor(d: Itinerary, f?: Flight): FlightDraft {
  if (f) {
    return {
      direction: f.direction!,
      airline: f.airline!,
      flightNumber: f.flightNumber!,
      fromAirport: f.fromAirport!,
      toAirport: f.toAirport!,
      departLocal: utcToLocal(f.scheduledDeparture!, airportTz(f.fromAirport!)),
      arriveLocal: utcToLocal(f.scheduledArrival!, airportTz(f.toAirport!)),
      confirmation: f.confirmation ?? '',
      bookingSource: f.bookingSource ?? '',
      notes: f.notes ?? '',
    }
  }
  const arriving = !d.flights?.some((x) => x.direction === 'arrival')
  const home = d.person.homeAirport ?? ''
  const day = (arriving ? d.preferredArrival : d.preferredDeparture) ?? ''
  return {
    direction: arriving ? 'arrival' : 'departure',
    airline: '',
    flightNumber: '',
    fromAirport: arriving ? home : THEATRE_AIRPORT,
    toAirport: arriving ? THEATRE_AIRPORT : home,
    departLocal: day ? `${day}T09:00` : '',
    arriveLocal: day ? `${day}T11:00` : '',
    confirmation: '',
    bookingSource: '',
    notes: '',
  }
}

function Flights({ itinerary: d }: { itinerary: Itinerary }) {
  const can = useCan()
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const edit = can('travel_logistics', 'edit')
  const flights = d.flights ?? []
  return (
    <div className="card wide">
      <div className="title-row">
        <h2>Flights</h2>
        {edit && editing !== 'new' ? (
          <button type="button" onClick={() => setEditing('new')}>
            Add a flight
          </button>
        ) : null}
      </div>
      {!flights.length && editing !== 'new' ? <p className="muted">No flights logged yet.</p> : null}
      {flights.map((f) =>
        editing === f.id ? (
          <FlightForm key={f.id} itinerary={d} flight={f} done={() => setEditing(null)} />
        ) : (
          <FlightRow key={f.id} flight={f} onEdit={edit ? () => setEditing(f.id!) : undefined} />
        ),
      )}
      {editing === 'new' ? <FlightForm itinerary={d} done={() => setEditing(null)} /> : null}
      <p className="muted small">Times are local to each airport.</p>
    </div>
  )
}

function FlightRow({ flight: f, onEdit }: { flight: Flight; onEdit?: () => void }) {
  const status = flightStatus({
    scheduledDeparture: f.scheduledDeparture!,
    scheduledArrival: f.scheduledArrival!,
    liveStatus: f.liveStatus ?? null,
    liveDeparture: f.liveDeparture ?? null,
    liveArrival: f.liveArrival ?? null,
  })
  return (
    <div className="leg">
      <div>
        <strong>
          {FLIGHT_DIRECTION_LABELS[f.direction!]}: {f.airline} {f.flightNumber}
        </strong>{' '}
        <span className={`chip tone-${status.tone}`}>{status.label}</span>
        <div className="small">
          {dayAt(f.scheduledDeparture, f.fromAirport!)}: {f.fromAirport} {timeAt(f.scheduledDeparture, f.fromAirport!)}{' '}
          to {f.toAirport} {timeAt(f.scheduledArrival, f.toAirport!)}
          {f.confirmation ? ` · Confirmation ${f.confirmation}` : ''}
          {f.bookingSource ? ` · ${f.bookingSource}` : ''}
        </div>
        {f.notes ? <div className="small muted">{f.notes}</div> : null}
      </div>
      {onEdit ? (
        <button type="button" className="secondary" onClick={onEdit}>
          Edit
        </button>
      ) : null}
    </div>
  )
}

function FlightForm({ itinerary: d, flight, done }: { itinerary: Itinerary; flight?: Flight; done: () => void }) {
  const trpc = useTRPC()
  const refresh = useRefresh(d.engagementId)
  const [draft, setDraft] = useState<FlightDraft>(() => draftFor(d, flight))
  const set = <K extends keyof FlightDraft>(k: K, v: FlightDraft[K]) => setDraft((x) => ({ ...x, [k]: v }))
  const add = useMutation(trpc.travel.addFlight.mutationOptions())
  const update = useMutation(trpc.travel.updateFlight.mutationOptions())
  const remove = useMutation(trpc.travel.removeFlight.mutationOptions())
  const error = add.error ?? update.error ?? remove.error
  const busy = add.isPending || update.isPending || remove.isPending

  async function save(ev: React.FormEvent) {
    ev.preventDefault()
    if (flight) await update.mutateAsync({ id: flight.id!, ...draft })
    else await add.mutateAsync({ engagementId: d.engagementId, ...draft })
    await refresh()
    done()
  }
  async function del() {
    if (!flight || !confirm('Remove this flight?')) return
    await remove.mutateAsync({ id: flight.id! })
    await refresh()
    done()
  }
  const text = (k: keyof FlightDraft, label: string, extra?: React.InputHTMLAttributes<HTMLInputElement>) => (
    <label>
      {label}
      <input value={draft[k]} onChange={(e) => set(k, e.target.value as never)} {...extra} />
    </label>
  )

  return (
    <form className="leg-form" onSubmit={(ev) => void save(ev).catch(() => undefined)}>
      <div className="grid">
        <label>
          Direction
          <select value={draft.direction} onChange={(e) => set('direction', e.target.value as FlightDirection)}>
            <option value="arrival">Arriving</option>
            <option value="departure">Going home</option>
          </select>
        </label>
        {text('airline', 'Airline code', { placeholder: 'AA', maxLength: 2, required: true })}
        {text('flightNumber', 'Flight number', { placeholder: '1234', required: true, inputMode: 'numeric' })}
        {text('fromAirport', 'From', { placeholder: 'LGA', maxLength: 3, required: true })}
        {text('toAirport', 'To', { placeholder: 'RDU', maxLength: 3, required: true })}
        <label>
          Departs (local time at {draft.fromAirport || 'origin'})
          <input
            type="datetime-local"
            value={draft.departLocal}
            required
            onChange={(e) => set('departLocal', e.target.value)}
          />
        </label>
        <label>
          Lands (local time at {draft.toAirport || 'destination'})
          <input
            type="datetime-local"
            value={draft.arriveLocal}
            required
            onChange={(e) => set('arriveLocal', e.target.value)}
          />
        </label>
        {text('confirmation', 'Confirmation code')}
        {text('bookingSource', 'Booked through')}
        <label className="span-all">
          Notes
          <textarea rows={2} value={draft.notes} onChange={(e) => set('notes', e.target.value)} />
        </label>
      </div>
      {error ? <p className="error">{errorText(error)}</p> : null}
      <div className="actions">
        <button type="submit" disabled={busy}>
          {flight ? 'Save flight' : 'Add flight'}
        </button>
        <button type="button" className="secondary" onClick={done}>
          Cancel
        </button>
        {flight ? (
          <button type="button" className="danger" disabled={busy} onClick={() => void del().catch(() => undefined)}>
            Remove
          </button>
        ) : null}
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Rental cars
// ---------------------------------------------------------------------------

interface CarDraft {
  company: string
  confirmation: string
  pickupLocal: string
  pickupPlace: string
  returnLocal: string
  returnPlace: string
  notes: string
}

function Cars({ itinerary: d }: { itinerary: Itinerary }) {
  const can = useCan()
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const edit = can('travel_logistics', 'edit')
  const cars = d.cars ?? []
  if (!d.carProvided && !cars.length) return null
  return (
    <div className="card wide">
      <div className="title-row">
        <h2>Rental car</h2>
        {edit && editing !== 'new' ? (
          <button type="button" onClick={() => setEditing('new')}>
            Add a car
          </button>
        ) : null}
      </div>
      {!cars.length && editing !== 'new' ? <p className="muted">No car booked yet.</p> : null}
      {cars.map((c) =>
        editing === c.id ? (
          <CarForm key={c.id} itinerary={d} car={c} done={() => setEditing(null)} />
        ) : (
          <div className="leg" key={c.id}>
            <div>
              <strong>{c.company}</strong>
              {c.confirmation ? <span className="muted"> · {c.confirmation}</span> : null}
              <div className="small">
                Pick up {dayAt(c.pickupAt, THEATRE_AIRPORT)} {timeAt(c.pickupAt, THEATRE_AIRPORT)}
                {c.pickupPlace ? ` at ${c.pickupPlace}` : ''}. Return {dayAt(c.returnAt, THEATRE_AIRPORT)}{' '}
                {timeAt(c.returnAt, THEATRE_AIRPORT)}
                {c.returnPlace ? ` at ${c.returnPlace}` : ''}.
              </div>
            </div>
            {edit ? (
              <button type="button" className="secondary" onClick={() => setEditing(c.id!)}>
                Edit
              </button>
            ) : null}
          </div>
        ),
      )}
      {editing === 'new' ? <CarForm itinerary={d} done={() => setEditing(null)} /> : null}
    </div>
  )
}

function CarForm({ itinerary: d, car, done }: { itinerary: Itinerary; car?: Car; done: () => void }) {
  const trpc = useTRPC()
  const refresh = useRefresh(d.engagementId)
  const [draft, setDraft] = useState<CarDraft>(() => ({
    company: car?.company ?? '',
    confirmation: car?.confirmation ?? '',
    pickupLocal: car ? utcToLocal(car.pickupAt!, THEATRE_TZ) : d.preferredArrival ? `${d.preferredArrival}T12:00` : '',
    pickupPlace: car?.pickupPlace ?? 'RDU rental car center',
    returnLocal: car
      ? utcToLocal(car.returnAt!, THEATRE_TZ)
      : d.preferredDeparture
        ? `${d.preferredDeparture}T08:00`
        : '',
    returnPlace: car?.returnPlace ?? 'RDU rental car center',
    notes: car?.notes ?? '',
  }))
  const set = (k: keyof CarDraft, v: string) => setDraft((x) => ({ ...x, [k]: v }))
  const add = useMutation(trpc.travel.addCar.mutationOptions())
  const update = useMutation(trpc.travel.updateCar.mutationOptions())
  const remove = useMutation(trpc.travel.removeCar.mutationOptions())
  const error = add.error ?? update.error ?? remove.error
  const busy = add.isPending || update.isPending || remove.isPending

  async function save(ev: React.FormEvent) {
    ev.preventDefault()
    if (car) await update.mutateAsync({ id: car.id!, ...draft })
    else await add.mutateAsync({ engagementId: d.engagementId, ...draft })
    await refresh()
    done()
  }
  async function del() {
    if (!car || !confirm('Remove this rental car?')) return
    await remove.mutateAsync({ id: car.id! })
    await refresh()
    done()
  }

  return (
    <form className="leg-form" onSubmit={(ev) => void save(ev).catch(() => undefined)}>
      <div className="grid">
        <label>
          Company
          <input value={draft.company} required onChange={(e) => set('company', e.target.value)} />
        </label>
        <label>
          Confirmation code
          <input value={draft.confirmation} onChange={(e) => set('confirmation', e.target.value)} />
        </label>
        <label>
          Pick up (Raleigh time)
          <input
            type="datetime-local"
            value={draft.pickupLocal}
            required
            onChange={(e) => set('pickupLocal', e.target.value)}
          />
        </label>
        <label>
          Pick up at
          <input value={draft.pickupPlace} onChange={(e) => set('pickupPlace', e.target.value)} />
        </label>
        <label>
          Return (Raleigh time)
          <input
            type="datetime-local"
            value={draft.returnLocal}
            required
            onChange={(e) => set('returnLocal', e.target.value)}
          />
        </label>
        <label>
          Return to
          <input value={draft.returnPlace} onChange={(e) => set('returnPlace', e.target.value)} />
        </label>
        <label className="span-all">
          Notes
          <textarea rows={2} value={draft.notes} onChange={(e) => set('notes', e.target.value)} />
        </label>
      </div>
      {error ? <p className="error">{errorText(error)}</p> : null}
      <div className="actions">
        <button type="submit" disabled={busy}>
          {car ? 'Save car' : 'Add car'}
        </button>
        <button type="button" className="secondary" onClick={done}>
          Cancel
        </button>
        {car ? (
          <button type="button" className="danger" disabled={busy} onClick={() => void del().catch(() => undefined)}>
            Remove
          </button>
        ) : null}
      </div>
    </form>
  )
}

// ---------------------------------------------------------------------------
// Housing
// ---------------------------------------------------------------------------

function Housing({ itinerary: d }: { itinerary: Itinerary }) {
  const trpc = useTRPC()
  const can = useCan()
  const refresh = useRefresh(d.engagementId)
  const edit = can('housing', 'edit')
  const units = useQuery({ ...trpc.housing.units.queryOptions(), enabled: edit })
  const housing = d.housing!
  // Start the form on the first nights they still need.
  const gap = housing.coverage.missing[0]
  const [roomId, setRoomId] = useState('')
  const [startsOn, setStartsOn] = useState(gap?.from ?? d.preferredArrival ?? '')
  const [endsOn, setEndsOn] = useState(gap?.to ?? d.preferredDeparture ?? '')
  const [editing, setEditing] = useState<string | null>(null)
  const assign = useMutation(trpc.housing.assign.mutationOptions())
  const remove = useMutation(trpc.housing.removeAssignment.mutationOptions())
  const rooms = (units.data ?? []).map((u) => (
    <optgroup key={u.id} label={u.name}>
      {u.rooms.map((r) => (
        <option key={r.id} value={r.id}>
          {r.name} (floor {r.floor}, {r.bathroom})
        </option>
      ))}
    </optgroup>
  ))

  async function submit(ev: React.FormEvent) {
    ev.preventDefault()
    await assign.mutateAsync({ engagementId: d.engagementId, roomId, startsOn, endsOn })
    setRoomId('')
    await refresh()
  }

  return (
    <div className="card wide">
      <h2>Housing</h2>
      {housing.need ? (
        <p className="small">
          Needs {formatDate(housing.need.from)} to {formatDate(housing.need.to)},{' '}
          {HOUSING_NEED_TEXT[housing.need.source]}.{' '}
          <span className={NEEDS_WORK.has(housing.coverage.status) ? 'warning' : 'muted'}>
            {COVERAGE_STATUS_LABELS[housing.coverage.status]}
            {housing.coverage.missing.length
              ? `: the ${housing.coverage.missing.map(nightRangeText).join(' and the ')}`
              : ''}
          </span>
        </p>
      ) : null}
      {!housing.stays.length ? (
        <p className="muted">
          {!d.housingProvided
            ? 'Housing isn’t part of this deal.'
            : housing.need
              ? 'No room assigned yet.'
              : 'No room assigned yet, and no dates to go on. Add their flights or the dates they asked for.'}
        </p>
      ) : null}
      {housing.stays.map((s) =>
        editing === s.id ? (
          <EditStay key={s.id} stay={s} rooms={rooms} onDone={() => setEditing(null)} refresh={refresh} />
        ) : (
          <div className="leg" key={s.id}>
            <div>
              <strong>
                {s.unit.name}, {s.room.name}
              </strong>
              <div className="small">
                {formatDate(s.startsOn)} to {formatDate(s.endsOn)} · floor {s.room.floor} · {s.room.bathroom}
              </div>
              {s.unit.address ? <div className="small muted">{s.unit.address}</div> : null}
              {s.unit.doorCode ? <div className="small">Door code {s.unit.doorCode}</div> : null}
              {housing.warnings
                .filter((w) => w.assignmentId === s.id)
                .map((w) => (
                  <div key={w.kind} className="warning small">
                    {w.message}
                  </div>
                ))}
            </div>
            {edit ? (
              <div className="actions">
                <button type="button" className="secondary" onClick={() => setEditing(s.id!)}>
                  Change
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={remove.isPending}
                  onClick={() =>
                    void remove
                      .mutateAsync({ id: s.id! })
                      .then(refresh)
                      .catch(() => undefined)
                  }
                >
                  Remove
                </button>
              </div>
            ) : null}
          </div>
        ),
      )}
      {remove.error ? <p className="error">{errorText(remove.error)}</p> : null}
      {edit ? (
        <form className="leg-form" onSubmit={(ev) => void submit(ev).catch(() => undefined)}>
          <div className="grid">
            <label>
              Room
              <select value={roomId} required onChange={(e) => setRoomId(e.target.value)}>
                <option value="">Pick a room</option>
                {rooms}
              </select>
            </label>
            <label>
              First night
              <input type="date" value={startsOn} required onChange={(e) => setStartsOn(e.target.value)} />
            </label>
            <label>
              Move-out day
              <input type="date" value={endsOn} required onChange={(e) => setEndsOn(e.target.value)} />
            </label>
          </div>
          {assign.error ? <p className="error">{errorText(assign.error)}</p> : null}
          <div className="actions">
            <button type="submit" disabled={assign.isPending}>
              Assign room
            </button>
            <Link to="/housing">See the housing calendar</Link>
          </div>
        </form>
      ) : null}
    </div>
  )
}

const HOUSING_NEED_TEXT = {
  flights: 'from their flights',
  preferred: 'from the dates they asked for',
  production: 'from the production dates',
} as const
const NEEDS_WORK = new Set(['unhoused', 'partly_housed', 'no_dates'])

type Stay = NonNullable<Itinerary['housing']>['stays'][number]

/** Moves a stay to another room or other dates. */
function EditStay({
  stay: s,
  rooms,
  onDone,
  refresh,
}: {
  stay: Stay
  rooms: React.ReactNode
  onDone: () => void
  refresh: () => Promise<unknown>
}) {
  const trpc = useTRPC()
  const [draft, setDraft] = useState({ roomId: s.room.id ?? '', startsOn: s.startsOn ?? '', endsOn: s.endsOn ?? '' })
  const update = useMutation(trpc.housing.updateAssignment.mutationOptions())
  return (
    <form
      className="leg-form"
      onSubmit={(ev) => {
        ev.preventDefault()
        void update
          .mutateAsync({ id: s.id!, ...draft })
          .then(refresh)
          .then(onDone)
          .catch(() => undefined)
      }}
    >
      <div className="grid">
        <label>
          Room
          <select value={draft.roomId} required onChange={(e) => setDraft({ ...draft, roomId: e.target.value })}>
            {rooms}
          </select>
        </label>
        <label>
          First night
          <input
            type="date"
            value={draft.startsOn}
            required
            onChange={(e) => setDraft({ ...draft, startsOn: e.target.value })}
          />
        </label>
        <label>
          Move-out day
          <input
            type="date"
            value={draft.endsOn}
            required
            onChange={(e) => setDraft({ ...draft, endsOn: e.target.value })}
          />
        </label>
      </div>
      {update.error ? <p className="error">{errorText(update.error)}</p> : null}
      <div className="actions">
        <button type="submit" disabled={update.isPending}>
          Save stay
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  )
}

function Preferences({ itinerary: d }: { itinerary: Itinerary }) {
  const trpc = useTRPC()
  const can = useCan()
  const refresh = useRefresh(d.engagementId)
  const setPref = useMutation(trpc.housing.setPreference.mutationOptions())
  const removePref = useMutation(trpc.housing.removePreference.mutationOptions())
  const edit = can('general', 'edit')
  if (!edit && !d.preferences.length) return null
  const has = (rule: HousingRule) => d.preferences.find((p) => p.rule === rule)

  return (
    <div className="card wide">
      <h2>Housing needs</h2>
      <p className="muted small">The housing calendar warns when a room doesn't fit these. It never blocks.</p>
      {HOUSING_RULES.map((rule) => {
        const pref = has(rule)
        return (
          <label key={rule} className="inline">
            <input
              type="checkbox"
              checked={Boolean(pref)}
              disabled={!edit || setPref.isPending || removePref.isPending}
              onChange={() => {
                const run = pref
                  ? removePref.mutateAsync({ id: pref.id! })
                  : setPref.mutateAsync({ personId: d.person.id, rule })
                void run.then(refresh).catch(() => undefined)
              }}
            />
            {HOUSING_RULE_LABELS[rule]}
            {pref?.note ? <span className="muted small"> ({pref.note})</span> : null}
          </label>
        )
      })}
      {setPref.error || removePref.error ? (
        <p className="error">{errorText(setPref.error ?? removePref.error)}</p>
      ) : null}
    </div>
  )
}
