import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  guessMapping,
  parseBool,
  parseCsv,
  parseDate,
  parseImportRow,
  parseMoney,
  parsePercent,
  type RawRow,
} from '../shared/import.js'

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, commas and newlines inside a cell', () => {
    const text = 'name,notes\r\n"Finch, Bart","Says ""hi""\nand bye"\r\nOdessa,\r\n'
    expect(parseCsv(text)).toEqual([
      ['name', 'notes'],
      ['Finch, Bart', 'Says "hi"\nand bye'],
      ['Odessa', ''],
    ])
  })

  it('drops a byte-order mark and blank lines', () => {
    expect(parseCsv('﻿a,b\n\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })
})

describe('guessMapping', () => {
  it('maps common header names and never maps two headers to one field', () => {
    expect(guessMapping(['Full Name', 'E-mail', 'Role/Position', 'Per Diem', 'Name', 'Shoe size'])).toEqual([
      'legalName',
      'email',
      'role',
      'weeklyStipend',
      null,
      null,
    ])
  })
})

describe('cell parsers', () => {
  it('reads money as whole cents and rejects junk', () => {
    expect(parseMoney('$1,250.50')).toBe(125050)
    expect(parseMoney('950')).toBe(95000)
    expect(parseMoney('')).toBeNull()
    expect(parseMoney('lots')).toBeUndefined()
    expect(parseMoney('-5')).toBeUndefined()
  })

  it('reads percents, with empty meaning no commission', () => {
    expect(parsePercent('10%')).toBe(10)
    expect(parsePercent('12.5')).toBe(12.5)
    expect(parsePercent('')).toBeNull()
    expect(parsePercent('150')).toBeUndefined()
  })

  it('reads ISO and US dates', () => {
    expect(parseDate('2027-02-07')).toBe('2027-02-07')
    expect(parseDate('2/7/2027')).toBe('2027-02-07')
    expect(parseDate('2/7/27')).toBe('2027-02-07')
    expect(parseDate('')).toBeNull()
    expect(parseDate('2/30/2027')).toBeUndefined()
  })

  it('reads yes and no, with blank meaning no and anything else unreadable', () => {
    expect(parseBool('Yes')).toBe(true)
    expect(parseBool('n')).toBe(false)
    expect(parseBool('')).toBe(false)
    expect(parseBool('maybe')).toBeNull()
  })
})

describe('parseImportRow', () => {
  it('collects every problem in a row, not just the first', () => {
    const r = parseImportRow({ weeklyPay: 'lots', contractType: 'Mystery' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors).toContain('Legal name is required.')
      expect(r.errors).toContain('Role is required.')
      expect(r.errors.length).toBeGreaterThanOrEqual(4)
    }
  })

  it('the sample CSV parses: six good rows and one with a problem', () => {
    const table = parseCsv(readFileSync(new URL('../samples/personnel-demo.csv', import.meta.url), 'utf8'))
    const mapping = guessMapping(table[0]!)
    expect(mapping).not.toContain(null)
    const parsed = table.slice(1).map((cells) => {
      const raw: RawRow = {}
      mapping.forEach((col, i) => {
        if (col) raw[col] = cells[i]
      })
      return parseImportRow(raw)
    })
    expect(parsed.filter((p) => p.ok)).toHaveLength(6)
    expect(parsed.filter((p) => !p.ok)).toHaveLength(1)
    const first = parsed[0]!
    expect(first.ok && first.value.terms).toMatchObject({
      contractType: 'equity_itc',
      weeklyPayCents: 115000,
      commissionPercent: 10,
      pipelineStatus: 'contract_sent',
    })
  })

  it('the sample CSV holds only made-up example.com contacts', () => {
    const text = readFileSync(new URL('../samples/personnel-demo.csv', import.meta.url), 'utf8')
    for (const email of text.match(/[^\s,"]+@[^\s,"]+/g) ?? []) expect(email).toMatch(/@example\.com$/)
    for (const phone of text.match(/\d{3}-\d{3}-\d{4}/g) ?? []) expect(phone).toMatch(/^\d{3}-555-01\d\d$/)
  })
})
