import { inngest, inngestEnabled } from '../inngest/client.js'
import { pushFeedOn } from './provider.js'

// Tells Inngest about flight changes after the database write has committed.
// Best effort: a failure is logged and never fails the save.

async function send(events: { name: string; data: Record<string, unknown> }[]): Promise<void> {
  try {
    await inngest.send(events)
  } catch (error) {
    console.error('could not tell Inngest about a flight change', error)
  }
}

/** A booked flight was added or rebooked: (re)start its watch. Only with the AeroDataBox feed. */
export async function flightSaved(flightId: string): Promise<void> {
  if (!inngestEnabled() || !pushFeedOn()) return
  await send([{ name: 'app/flight.saved', data: { flightId } }])
}

/** A booked flight was removed: stop its watch and let go of its subscription. */
export async function flightRemoved(flightId: string, subscriptionId: string | null): Promise<void> {
  if (!inngestEnabled() || (!pushFeedOn() && !subscriptionId)) return
  await send([{ name: 'app/flight.removed', data: { flightId, subscriptionId } }])
}

/** The board logged changes with the simulated feed: email them. */
export async function flightsChanged(): Promise<void> {
  if (!inngestEnabled()) return
  await send([{ name: 'app/flights.changed', data: {} }])
}

/** A staff flight test started: end it after a while even if the flight never lands. */
export async function testStarted(subscriptionId: string): Promise<void> {
  if (!inngestEnabled()) return
  await send([{ name: 'app/flight-test.started', data: { subscriptionId } }])
}
