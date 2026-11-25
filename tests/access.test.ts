import { describe, expect, it } from 'vitest'
import {
  ACCESS_LEVELS,
  checkGrantChange,
  DEFAULT_GRANTS,
  FIELD_GROUPS,
  filterRecord,
  isMasked,
  levelAtLeast,
  levelFor,
  NEVER_OVER_CONNECTOR,
  PERSON_FIELDS,
} from '../shared/access.js'

const record = {
  id: 'p1',
  legalName: 'Avery Castellano',
  preferredName: null,
  email: 'avery@example.com',
  cell: '919-555-0101',
  homeAirport: 'LGA',
  dob: 'v1.ciphertext',
  tsaKtn: null,
  frequentFlyer: 'v1.ciphertext',
}

describe('levels', () => {
  it('orders none < view < review < edit', () => {
    expect(ACCESS_LEVELS).toEqual(['none', 'view', 'review', 'edit'])
    expect(levelAtLeast('edit', 'view')).toBe(true)
    expect(levelAtLeast('review', 'view')).toBe(true)
    expect(levelAtLeast('view', 'review')).toBe(false)
    expect(levelAtLeast('none', 'view')).toBe(false)
  })

  it('treats a missing grant as none', () => {
    expect(levelFor({}, 'general')).toBe('none')
  })
})

describe('default grants match the plan', () => {
  it('gives the Company Manager edit on every group', () => {
    for (const g of FIELD_GROUPS) expect(DEFAULT_GRANTS.company_manager[g]).toBe('edit')
  })

  it('keeps Finance out of travel IDs, travel logistics, housing and comps', () => {
    const f = DEFAULT_GRANTS.finance_manager
    for (const g of ['travel_id', 'travel_logistics', 'housing_access', 'comps'] as const) {
      expect(levelFor(f, g)).toBe('none')
    }
    expect(f.tax_bank).toBe('review')
    expect(f.personal_id).toBe('view')
  })

  it('never serves the most sensitive groups over the AI connector', () => {
    expect([...NEVER_OVER_CONNECTOR].sort()).toEqual(['housing_access', 'personal_id', 'tax_bank', 'travel_id'])
  })
})

describe('filterRecord', () => {
  it('returns only the id when there are no grants (default deny)', () => {
    expect(filterRecord(record, PERSON_FIELDS, {})).toEqual({ id: 'p1' })
  })

  it('masks sensitive groups and never returns their stored values', () => {
    const out = filterRecord(record, PERSON_FIELDS, DEFAULT_GRANTS.company_manager)
    expect(out.legalName).toBe('Avery Castellano')
    expect(out.dob).toEqual({ masked: true, hasValue: true })
    expect(out.tsaKtn).toEqual({ masked: true, hasValue: false })
    expect(JSON.stringify(out)).not.toContain('ciphertext')
  })

  it('drops groups a role has no grant for', () => {
    const out = filterRecord(record, PERSON_FIELDS, DEFAULT_GRANTS.finance_manager)
    expect(out.email).toBe('avery@example.com')
    expect(isMasked(out.dob)).toBe(true)
    expect('tsaKtn' in out).toBe(false)
    expect('frequentFlyer' in out).toBe(false)
  })

  it('drops fields missing from the registry, so a new column cannot leak', () => {
    const out = filterRecord({ ...record, ssn: '000-00-0000' }, PERSON_FIELDS, DEFAULT_GRANTS.company_manager)
    expect('ssn' in out).toBe(false)
  })
})

describe('checkGrantChange', () => {
  it("refuses changes to the Company Manager's own grants", () => {
    expect(checkGrantChange('company_manager', 'general', 'view', true)).toEqual({
      ok: false,
      reason: 'admin_role_fixed',
    })
  })

  it('needs a second confirmation to grant travel IDs or tax and bank docs', () => {
    expect(checkGrantChange('finance_manager', 'travel_id', 'view', false)).toEqual({
      ok: false,
      reason: 'needs_confirmation',
    })
    expect(checkGrantChange('finance_manager', 'travel_id', 'view', true)).toEqual({ ok: true })
    expect(checkGrantChange('finance_manager', 'tax_bank', 'none', false)).toEqual({ ok: true })
    expect(checkGrantChange('finance_manager', 'contact', 'edit', false)).toEqual({ ok: true })
  })
})
