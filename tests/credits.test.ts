import { describe, expect, it } from 'vitest'
import { createDb, type Db } from '../server/db/client.js'
import type { AdbClient } from '../server/flights/aerodatabox.js'
import {
  autoTopUp,
  autoTopUpsThisMonth,
  monthStart,
  TOP_UP_DEFAULTS,
  topUpOn,
  topUpSettings,
} from '../server/flights/credits.js'

describe('automatic top-up settings', () => {
  it('defaults to below 100, add 500, up to 10,000 a month', () => {
    expect(topUpSettings({})).toEqual({ below: 100, amount: 500, monthlyMax: 10_000 })
    expect(TOP_UP_DEFAULTS).toEqual(topUpSettings({}))
  })

  it('reads whole numbers from Vercel settings, and falls back on anything else', () => {
    expect(
      topUpSettings({
        AERODATABOX_TOP_UP_BELOW: '250',
        AERODATABOX_TOP_UP_AMOUNT: '1000',
        AERODATABOX_TOP_UP_MONTHLY_MAX: '20000',
      }),
    ).toEqual({ below: 250, amount: 1000, monthlyMax: 20_000 })
    expect(
      topUpSettings({
        AERODATABOX_TOP_UP_BELOW: 'lots',
        AERODATABOX_TOP_UP_AMOUNT: '-5',
        AERODATABOX_TOP_UP_MONTHLY_MAX: '1.5',
      }),
    ).toEqual(TOP_UP_DEFAULTS)
  })

  it('0 for the amount or the cap turns it off', () => {
    expect(topUpOn(topUpSettings({ AERODATABOX_TOP_UP_AMOUNT: '0' }))).toBe(false)
    expect(topUpOn(topUpSettings({ AERODATABOX_TOP_UP_MONTHLY_MAX: '0' }))).toBe(false)
    expect(topUpOn(topUpSettings({}))).toBe(true)
  })

  it('months start at midnight on the 1st, theatre time', () => {
    // 03:00 UTC on 1 March is still 28 February in New York.
    expect(monthStart(new Date('2027-03-15T12:00:00Z')).toISOString()).toBe('2027-03-01T05:00:00.000Z')
    expect(monthStart(new Date('2027-03-01T03:00:00Z')).toISOString()).toBe('2027-02-01T05:00:00.000Z')
    expect(monthStart(new Date('2027-07-04T12:00:00Z')).toISOString()).toBe('2027-07-01T04:00:00.000Z')
  })
})

/** A fake AeroDataBox balance that refills like the real one. */
function fakeBalance(start: number | null) {
  let balance = start
  const refills: number[] = []
  const api: AdbClient = {
    subscribe: async () => ({ id: 'x' }),
    unsubscribe: async () => undefined,
    balance: async () => balance,
    refill: async (credits) => {
      refills.push(credits)
      balance = (balance ?? 0) + credits
      return balance
    },
  }
  return { api, refills }
}

const url = process.env.DATABASE_URL
describe.skipIf(!url)('automatic top-up against Postgres', () => {
  const db = (url ? createDb(url) : null) as Db
  // The audit log can't be cleared, so each case works from what's already there.
  const now = new Date()

  it('tops up below the threshold, and records it for the monthly cap', async () => {
    const used = await autoTopUpsThisMonth(db, now)
    const { api, refills } = fakeBalance(40)
    const result = await autoTopUp(db, api, now, { below: 100, amount: 500, monthlyMax: used + 10_000 })
    expect(result).toMatchObject({ action: 'topped_up', credits: 540, added: 500, usedThisMonth: used + 500 })
    expect(refills).toEqual([500])
    expect(await autoTopUpsThisMonth(db, now)).toBe(used + 500)
  })

  it('leaves a healthy balance alone', async () => {
    const { api, refills } = fakeBalance(100)
    expect(await autoTopUp(db, api, now, { below: 100, amount: 500, monthlyMax: 1_000_000 })).toEqual({
      action: 'enough',
      credits: 100,
    })
    expect(refills).toEqual([])
  })

  it('adds only what the monthly cap still allows, then stops', async () => {
    const used = await autoTopUpsThisMonth(db, now)
    const settings = { below: 100, amount: 500, monthlyMax: used + 200 }
    const first = fakeBalance(0)
    expect(await autoTopUp(db, first.api, now, settings)).toMatchObject({ action: 'topped_up', added: 200 })
    const second = fakeBalance(0)
    expect(await autoTopUp(db, second.api, now, settings)).toMatchObject({ action: 'capped', credits: 0 })
    expect(second.refills).toEqual([])
  })

  it('does nothing when turned off, or when the balance is unknown', async () => {
    const off = fakeBalance(0)
    expect(await autoTopUp(db, off.api, now, { below: 100, amount: 0, monthlyMax: 10_000 })).toEqual({
      action: 'off',
      credits: 0,
    })
    const unknown = fakeBalance(null)
    expect(await autoTopUp(db, unknown.api, now, TOP_UP_DEFAULTS)).toEqual({ action: 'unknown', credits: null })
    expect([...off.refills, ...unknown.refills]).toEqual([])
  })
})
