import { describe, expect, it } from 'vitest'
import { clampStep, parseTourState, pickShowcaseContract, TOUR_STEPS, tourStep } from '../shared/tour.js'

describe('guided tour', () => {
  it('has a handful of short stops with unique ids', () => {
    expect(TOUR_STEPS.length).toBeGreaterThanOrEqual(5)
    expect(TOUR_STEPS.length).toBeLessThanOrEqual(10)
    expect(new Set(TOUR_STEPS.map((s) => s.id)).size).toBe(TOUR_STEPS.length)
    // About a minute in all: no stop reads like an essay.
    for (const s of TOUR_STEPS) expect(s.body.split(/\s+/).length).toBeLessThanOrEqual(70)
  })

  it('starts at home and every stop with a looked-up page still has a fallback path', () => {
    expect(TOUR_STEPS[0]?.path).toBe('/')
    for (const s of TOUR_STEPS) if (s.place) expect(s.path).toMatch(/^\//)
  })

  it('keeps the AeroDataBox credit on the arrivals stop', () => {
    expect(TOUR_STEPS.find((s) => s.id === 'arrivals')?.body).toContain('AeroDataBox')
  })

  it('never sends a guest to a staff-only page', () => {
    const staffOnly = ['/admin/', '/settings/alerts', '/settings/connections', '/drafts']
    for (const s of TOUR_STEPS) for (const p of staffOnly) expect(s.path ?? '').not.toContain(p)
  })

  it('reads saved state safely', () => {
    expect(parseTourState('{"open":true,"step":3}')).toEqual({ open: true, step: 3 })
    expect(parseTourState('{"open":true,"step":999}')).toEqual({ open: true, step: TOUR_STEPS.length - 1 })
    expect(parseTourState('{"open":"yes","step":-4}')).toEqual({ open: false, step: 0 })
    expect(parseTourState('not json')).toEqual({ open: false, step: 0 })
    expect(parseTourState('null')).toEqual({ open: false, step: 0 })
    expect(clampStep(Number.NaN)).toBe(0)
    expect(clampStep(2.7)).toBe(2)
    expect(tourStep(-1).id).toBe(TOUR_STEPS[0]?.id)
  })

  it('shows an Equity contract first, then SDC, then any, never a void one', () => {
    const c = (id: string, format: string, status: string | null = 'draft') => ({ id, status, template: { format } })
    expect(
      pickShowcaseContract([
        { contracts: [c('text', 'text'), c('sdc', 'sdc_form')] },
        { contracts: [c('eq', 'equity_itc_form')] },
      ]),
    ).toBe('eq')
    expect(pickShowcaseContract([{ contracts: [c('text', 'text'), c('sdc', 'sdc_form')] }])).toBe('sdc')
    expect(pickShowcaseContract([{ contracts: [c('void', 'equity_itc_form', 'void'), c('text', 'text')] }])).toBe(
      'text',
    )
    expect(pickShowcaseContract([{ contracts: [] }])).toBeNull()
  })
})
