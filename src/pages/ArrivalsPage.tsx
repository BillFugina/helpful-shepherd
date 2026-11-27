import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ADMIN_ROLE } from '../../shared/access'
import { PIPELINE_LABELS } from '../../shared/roster'
import { addDays, THEATRE_AIRPORT, zonedToUtc } from '../../shared/time'
import { loadGuestClock, saveGuestClock } from '../lib/demo'
import { errorText } from '../lib/errors'
import { formatDate, useCan } from '../lib/fields'
import {
  dayAt,
  expectedArrival,
  expectedDeparture,
  flightStatus,
  formatTime,
  phoneHref,
  THEATRE_TZ,
  timeAt,
} from '../lib/travel'
import { useTRPC } from '../lib/trpc'
import type { Outputs } from '../lib/types'
import { useMe } from '../lib/useMe'

type Board = Outputs['arrivals']['board']
type Entry = Board['arrivals'][number]
type Person = Board['arrivingNoFlight'][number]
type Alert = Board['alerts'][number]

/**
 * The travel-day board: who lands and who leaves on one day, with what the
 * flight feed says now. Built for a phone in a car at the airport.
 */
export function ArrivalsPage() {
  const trpc = useTRPC()
  const me = useMe()
  const [params, setParams] = useSearchParams()
  const date = params.get('date') ?? undefined
  // A guest has a demo clock of their own, kept in this tab. Null until it's
  // first set; 0 means real time.
  const guest = me.data?.guest === true
  const [guestClock, setGuestClockState] = useState<number | null>(() => loadGuestClock())
  const setGuestClock = (offsetMs: number) => {
    saveGuestClock(offsetMs)
    setGuestClockState(offsetMs)
  }
  const board = useQuery({
    ...trpc.arrivals.board.queryOptions({
      date,
      ...(guest && guestClock !== null ? { clockOffsetMs: guestClock } : {}),
    }),
    enabled: !me.isPending,
    refetchInterval: 60_000,
  })

  // A guest's first look starts at noon on the first travel day, when some
  // flights have landed, some are in the air and the feed has news.
  const firstTravelDay = board.data?.firstTravelDay
  useEffect(() => {
    if (!guest || guestClock !== null || !firstTravelDay) return
    const offsetMs = zonedToUtc(`${firstTravelDay}T12:00`, THEATRE_TZ).getTime() - Date.now()
    saveGuestClock(offsetMs)
    // Runs once, after the first board says which day to start on; the clock
    // depends on the real time when it's set, so it can't be worked out in render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setGuestClockState(offsetMs)
  }, [guest, guestClock, firstTravelDay])

  if (board.isPending) return <p className="muted">Loading…</p>
  if (board.error) return <p className="error">{errorText(board.error)}</p>
  const b = board.data
  const goTo = (d: string | null) => setParams(d && d !== b.today ? { date: d } : {})
  const empty = !b.arrivals.length && !b.departures.length && !b.arrivingNoFlight.length && !b.leavingNoFlight.length

  return (
    <section className="board">
      <div className="title-row">
        <h1>Arrivals</h1>
        <div className="actions">
          <button type="button" className="secondary" onClick={() => goTo(addDays(b.date, -1))} aria-label="Day before">
            ‹
          </button>
          <strong>{formatDate(b.date)}</strong>
          <button type="button" className="secondary" onClick={() => goTo(addDays(b.date, 1))} aria-label="Day after">
            ›
          </button>
          {b.date !== b.today ? (
            <button type="button" className="link" onClick={() => goTo(null)}>
              Today
            </button>
          ) : null}
        </div>
      </div>

      {b.clock.usesDemoClock ? <DemoClock board={b} own={guest ? setGuestClock : null} /> : null}
      <Alerts alerts={b.alerts} />

      {empty ? (
        <div className="card">
          <p>No one lands or leaves on {formatDate(b.date)}.</p>
          {b.nextTravelDay ? (
            <button type="button" onClick={() => goTo(b.nextTravelDay)}>
              Go to the next travel day, {formatDate(b.nextTravelDay)}
            </button>
          ) : null}
        </div>
      ) : null}

      {b.arrivals.length || b.arrivingNoFlight.length ? (
        <>
          <h2>Arriving ({b.arrivals.length + b.arrivingNoFlight.length})</h2>
          <div className="board-list">
            {[...b.arrivals]
              .sort((x, y) => expectedArrival(x.legs.at(-1)!).getTime() - expectedArrival(y.legs.at(-1)!).getTime())
              .map((e) => (
                <ArrivalCard key={e.engagementId} entry={e} date={b.date} />
              ))}
            {b.arrivingNoFlight.map((p) => (
              <NoFlightCard key={p.engagementId} person={p} what="arrival" />
            ))}
          </div>
        </>
      ) : null}

      {b.departures.length || b.leavingNoFlight.length ? (
        <>
          <h2>Leaving ({b.departures.length + b.leavingNoFlight.length})</h2>
          <div className="board-list">
            {[...b.departures]
              .sort((x, y) => expectedDeparture(x.legs[0]!).getTime() - expectedDeparture(y.legs[0]!).getTime())
              .map((e) => (
                <DepartureCard key={e.engagementId} entry={e} />
              ))}
            {b.leavingNoFlight.map((p) => (
              <NoFlightCard key={p.engagementId} person={p} what="departure" />
            ))}
          </div>
        </>
      ) : null}

      {!empty && b.nextTravelDay ? (
        <p>
          <button type="button" className="link" onClick={() => goTo(b.nextTravelDay)}>
            Next travel day: {formatDate(b.nextTravelDay)}
          </button>
        </p>
      ) : null}
      <p className="muted small">
        {b.clock.provider === 'aerodatabox'
          ? 'Flight data: AeroDataBox. Updates arrive as they happen; this page refreshes every minute while it’s open.'
          : 'Flight status comes from a simulated feed for the demo, and refreshes every minute while this page is open.'}
      </p>
      {!guest && me.data?.role === ADMIN_ROLE ? <LiveTest /> : null}
    </section>
  )
}

function Who({ entry }: { entry: Person }) {
  return (
    <div className="who">
      <Link to={`/engagements/${entry.engagementId}/travel`} className="who-name">
        {entry.name}
      </Link>
      <span className="muted small">
        {entry.role} · {entry.production}
      </span>
    </div>
  )
}

function ContactButtons({ entry, arrived }: { entry: Person; arrived?: boolean }) {
  const trpc = useTRPC()
  const can = useCan()
  const queryClient = useQueryClient()
  const setStatus = useMutation(
    trpc.engagements.setStatus.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.arrivals.board.pathKey() }),
    }),
  )
  return (
    <div className="actions">
      {entry.cell ? (
        <>
          <a className="button secondary" href={phoneHref('tel', entry.cell)}>
            Call
          </a>
          <a className="button secondary" href={phoneHref('sms', entry.cell)}>
            Text
          </a>
        </>
      ) : null}
      {arrived && can('general', 'edit') ? (
        entry.pipelineStatus === 'arrived' ? (
          <span className="chip status-arrived">{PIPELINE_LABELS.arrived}</span>
        ) : (
          <button
            type="button"
            disabled={setStatus.isPending}
            onClick={() => setStatus.mutate({ id: entry.engagementId, status: 'arrived' })}
          >
            Mark arrived
          </button>
        )
      ) : null}
      {setStatus.error ? <span className="error">{errorText(setStatus.error)}</span> : null}
    </div>
  )
}

function StatusChip({ tone, label }: { tone: string; label: string }) {
  return <span className={`chip tone-${tone}`}>{label}</span>
}

function ArrivalCard({ entry, date }: { entry: Entry; date: string }) {
  const last = entry.legs.at(-1)!
  const status = flightStatus(last)
  const expected = expectedArrival(last)
  const late = expected.getTime() !== last.scheduledArrival.getTime()
  return (
    <article className={`card board-card tone-edge-${status.tone}`}>
      <div className="board-top">
        <Who entry={entry} />
        <div className="board-time">
          <strong className={late ? 'changed' : undefined}>{timeAt(expected, last.toAirport)}</strong>
          {late ? <s className="muted small">{timeAt(last.scheduledArrival, last.toAirport)}</s> : null}
        </div>
      </div>
      <p className="board-flight">
        {entry.legs.map((l, i) => (
          <span key={l.id}>
            {i ? ' then ' : ''}
            {l.airline} {l.flightNumber} {l.fromAirport} to {l.toAirport}
          </span>
        ))}{' '}
        <StatusChip {...status} />
      </p>
      <p className="small">
        {[
          last.liveTerminal,
          last.liveGate ? `Gate ${last.liveGate}` : null,
          last.liveBaggage ? `Bags at carousel ${last.liveBaggage}` : null,
        ]
          .filter(Boolean)
          .join(' · ') || <span className="muted">Gate not posted yet</span>}
      </p>
      {entry.car ? (
        <p className="small">
          Car: {entry.car.company}, pick up {formatTime(entry.car.pickupAt, THEATRE_TZ)}
          {entry.car.pickupPlace ? ` at ${entry.car.pickupPlace}` : ''}
          {entry.car.confirmation ? ` (${entry.car.confirmation})` : ''}
        </p>
      ) : null}
      {entry.housingTonight !== undefined ? (
        <p className="small">
          {entry.housingTonight ? (
            <>
              Tonight: {entry.housingTonight.unit}, {entry.housingTonight.room}
              {entry.housingTonight.doorCode ? ` · Door code ${entry.housingTonight.doorCode}` : ''}
            </>
          ) : (
            <span className="error">No room booked for {formatDate(date)}.</span>
          )}
        </p>
      ) : null}
      <ContactButtons entry={entry} arrived />
    </article>
  )
}

function DepartureCard({ entry }: { entry: Entry }) {
  const first = entry.legs[0]!
  const status = flightStatus(first)
  const expected = expectedDeparture(first)
  const late = expected.getTime() !== first.scheduledDeparture.getTime()
  return (
    <article className={`card board-card tone-edge-${status.tone}`}>
      <div className="board-top">
        <Who entry={entry} />
        <div className="board-time">
          <strong className={late ? 'changed' : undefined}>{timeAt(expected, first.fromAirport)}</strong>
          {late ? <s className="muted small">{timeAt(first.scheduledDeparture, first.fromAirport)}</s> : null}
        </div>
      </div>
      <p className="board-flight">
        {entry.legs.map((l, i) => (
          <span key={l.id}>
            {i ? ' then ' : ''}
            {l.airline} {l.flightNumber} {l.fromAirport} to {l.toAirport}
          </span>
        ))}{' '}
        <StatusChip {...status} />
      </p>
      <p className="small">
        {[first.liveTerminal, first.liveGate ? `Gate ${first.liveGate}` : null].filter(Boolean).join(' · ') || (
          <span className="muted">Gate not posted yet</span>
        )}
      </p>
      {entry.car ? (
        <p className="small">
          Car back to {entry.car.returnPlace ?? entry.car.company} by {formatTime(entry.car.returnAt, THEATRE_TZ)}
        </p>
      ) : null}
      <ContactButtons entry={entry} />
    </article>
  )
}

function NoFlightCard({ person, what }: { person: Person; what: 'arrival' | 'departure' }) {
  return (
    <article className="card board-card tone-edge-warn">
      <div className="board-top">
        <Who entry={person} />
      </div>
      <p className="small">
        Expected to {what === 'arrival' ? 'arrive' : 'leave'} today, but no {what === 'arrival' ? 'arriving' : 'return'}{' '}
        flight is logged. <Link to={`/engagements/${person.engagementId}/travel`}>Add it</Link>
      </p>
      <ContactButtons entry={person} />
    </article>
  )
}

const ALERT_TEXT: Record<Alert['kind'], (a: Alert) => string> = {
  delayed: (a) => `delayed ${String(a.detail?.minutes ?? '')} min`,
  gate_change: (a) => `gate changed ${String(a.detail?.from ?? '')} to ${String(a.detail?.to ?? '')}`,
  departed: () => 'took off',
  landed: (a) => (a.detail?.baggage ? `landed, bags at carousel ${String(a.detail.baggage)}` : 'landed'),
  cancelled: () => 'cancelled',
}

function Alerts({ alerts }: { alerts: Alert[] }) {
  if (!alerts.length) return null
  return (
    <div className="card alerts">
      <h2>Alerts</h2>
      <ul className="plain">
        {alerts.map((a) => (
          <li key={a.id} className={a.kind === 'cancelled' || a.kind === 'delayed' ? 'alert-bad' : undefined}>
            <span className="muted small">{formatTime(a.at, THEATRE_TZ)}</span> {a.name}: {a.flight}{' '}
            {ALERT_TEXT[a.kind](a)}
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Lets the Company Manager replay a travel day with the simulated feed. Moving
 * the clock clears what the feed said before; the board fills in again.
 *
 * A guest gets the same buttons on a clock of their own (`own`), which only
 * changes what their board asks the server for, so nobody else's board moves.
 */
function DemoClock({ board: b, own }: { board: Board; own: ((offsetMs: number) => void) | null }) {
  const trpc = useTRPC()
  const me = useMe()
  const queryClient = useQueryClient()
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.arrivals.board.pathKey() })
  const setClock = useMutation(trpc.arrivals.setClock.mutationOptions({ onSuccess: refresh }))
  const resetClock = useMutation(trpc.arrivals.resetClock.mutationOptions({ onSuccess: refresh }))
  const busy = setClock.isPending || resetClock.isPending
  const moved = b.clock.offsetMs !== 0
  const moveTo = (at: Date) => (own ? own(at.getTime() - Date.now()) : setClock.mutate({ at: at.toISOString() }))
  const jumpTo = (date: string) => moveTo(zonedToUtc(`${date}T06:00`, THEATRE_TZ))
  const forward = (hours: number) => moveTo(new Date(b.now.getTime() + hours * 3_600_000))
  const backToRealTime = () => (own ? own(0) : resetClock.mutate())
  const travelDay = b.arrivals.length || b.departures.length ? b.date : (b.nextTravelDay ?? b.firstTravelDay)

  return (
    <div className="card demo-clock">
      <p className="small">
        <strong>{own ? 'Your demo clock' : 'Demo clock'}:</strong> the feed thinks it's {dayAt(b.now, THEATRE_AIRPORT)},{' '}
        {timeAt(b.now, THEATRE_AIRPORT)}
        {moved ? '' : ' (real time)'}.{own ? ' Only your board follows it.' : ''}
      </p>
      {own || me.data?.role === ADMIN_ROLE ? (
        <div className="actions">
          {travelDay ? (
            <button type="button" disabled={busy} onClick={() => jumpTo(travelDay)}>
              Start {formatDate(travelDay)} at 6 AM
            </button>
          ) : null}
          {moved ? (
            <>
              <button type="button" className="secondary" disabled={busy} onClick={() => forward(1)}>
                +1 hour
              </button>
              <button type="button" className="secondary" disabled={busy} onClick={() => forward(3)}>
                +3 hours
              </button>
              <button type="button" className="link" disabled={busy} onClick={backToRealTime}>
                Back to real time
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {setClock.error || resetClock.error ? (
        <p className="error">{errorText(setClock.error ?? resetClock.error)}</p>
      ) : null}
    </div>
  )
}

/**
 * For staff: watch any real flight for a few hours and see AeroDataBox's
 * updates arrive, without touching the demo people. Shown only when an
 * AeroDataBox key is set. Each update costs one credit.
 */
function LiveTest() {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const [number, setNumber] = useState('')
  const tests = useQuery({ ...trpc.arrivals.liveTests.queryOptions(), refetchInterval: 30_000 })
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.arrivals.liveTests.queryKey() })
  const start = useMutation(
    trpc.arrivals.startLiveTest.mutationOptions({
      onSuccess: () => {
        setNumber('')
        return refresh()
      },
    }),
  )
  const stop = useMutation(trpc.arrivals.stopLiveTest.mutationOptions({ onSuccess: refresh }))
  if (!tests.data?.available) return null

  return (
    <div className="card live-test">
      <h2>Watch a real flight (test)</h2>
      <p className="small">
        Enter a flight that flies in the next few hours. Updates show here and are emailed to you. The test ends when
        the flight lands, or after 12 hours. Each update costs one AeroDataBox credit.
      </p>
      <form
        className="actions"
        onSubmit={(e) => {
          e.preventDefault()
          if (number.trim()) start.mutate({ flightNumber: number })
        }}
      >
        <input
          aria-label="Flight number"
          placeholder="B6 1017"
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          maxLength={12}
        />
        <button type="submit" disabled={start.isPending || !number.trim()}>
          Start watching
        </button>
      </form>
      {start.error || stop.error ? <p className="error">{errorText(start.error ?? stop.error)}</p> : null}
      {tests.data.tests.map((t) => (
        <div key={t.id} className="live-test-run">
          <p className="small">
            <strong>{t.flightNumber}</strong> {t.active ? (t.subscribed ? 'watching' : 'subscribing…') : 'ended'},
            started {formatTime(t.startedAt, THEATRE_TZ)}
            {t.creditsRemaining !== null ? `, ${t.creditsRemaining} credits left` : ''}
            {t.active ? (
              <>
                {' '}
                <button
                  type="button"
                  className="link"
                  disabled={stop.isPending}
                  onClick={() => stop.mutate({ id: t.id })}
                >
                  Stop
                </button>
              </>
            ) : null}
          </p>
          {t.pushes.length ? (
            <ul className="plain small">
              {t.pushes.map((p) => (
                <li key={p.id}>
                  <span className="muted">{formatTime(p.receivedAt, THEATRE_TZ)}</span> {p.number}
                  {p.fromAirport && p.toAirport ? ` ${p.fromAirport} to ${p.toAirport}` : ''}: {p.status}
                  {p.summary ? `. ${p.summary}` : ''}
                </li>
              ))}
            </ul>
          ) : t.active ? (
            <p className="muted small">No updates yet. They come when something about the flight changes.</p>
          ) : null}
        </div>
      ))}
      <p className="muted small">Flight data: AeroDataBox.</p>
    </div>
  )
}
