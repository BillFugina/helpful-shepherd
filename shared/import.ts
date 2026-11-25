/**
 * The personnel-spreadsheet import, as pure functions so both ends and the
 * tests share them: CSV parsing and column guessing run in the browser for
 * the mapping screen, and the server parses every row again before it writes.
 */
import type { z } from 'zod'
import {
  CONTRACT_TYPE_LABELS,
  CONTRACT_TYPES,
  engagementTerms,
  IMPORT_COLUMNS,
  PIPELINE_LABELS,
  PIPELINE_STATUSES,
  agentFields,
  personFields,
  type ContractType,
  type ImportColumn,
  type PipelineStatus,
} from './roster.js'

/** RFC 4180 CSV: quoted fields, doubled quotes, commas and newlines inside quotes, CRLF, a leading BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  const src = text.startsWith('﻿') ? text.slice(1) : text
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += c
    } else if (c === '"' && field === '') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else field += c
  }
  if (field !== '' || row.length) {
    row.push(field)
    rows.push(row)
  }
  // Drop blank lines.
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''))
}

const SYNONYMS: Record<ImportColumn, string[]> = {
  legalName: ['legal name', 'name', 'full name', 'legal id name', 'name on id'],
  preferredName: ['preferred name', 'goes by', 'nickname'],
  email: ['email', 'e mail', 'email address'],
  cell: ['cell', 'phone', 'mobile', 'cell phone'],
  homeAirport: ['home airport', 'airport'],
  role: ['role', 'position', 'role position', 'track'],
  contractType: ['contract type', 'contract', 'union', 'contract union'],
  weeklyPay: ['weekly pay', 'pay', 'salary', 'weekly salary', 'weekly'],
  commissionPercent: ['commission', 'agent commission', 'commission percent', 'commission %'],
  weeklyStipend: ['stipend', 'weekly stipend', 'per diem'],
  agentName: ['agent', 'agent name'],
  agency: ['agency'],
  agentEmail: ['agent email'],
  agentPhone: ['agent phone'],
  travelProvided: ['travel', 'travel provided', 'flight provided', 'airfare'],
  carProvided: ['car', 'rental car', 'car provided', 'rental car provided'],
  housingProvided: ['housing', 'housing provided'],
  preferredArrival: ['arrival', 'preferred arrival', 'arrive', 'travel in'],
  preferredDeparture: ['departure', 'preferred departure', 'depart', 'travel out'],
  pipelineStatus: ['status', 'pipeline', 'pipeline status', 'stage'],
  notes: ['notes', 'note', 'comments'],
}

function normalize(header: string): string {
  return header
    .toLowerCase()
    .replace(/[^a-z0-9%]+/g, ' ')
    .trim()
}

/** Best guess at which import column each header holds. Each column is used at most once. */
export function guessMapping(headers: readonly string[]): (ImportColumn | null)[] {
  const used = new Set<ImportColumn>()
  return headers.map((h) => {
    const n = normalize(h)
    const hit = IMPORT_COLUMNS.find((col) => !used.has(col) && SYNONYMS[col].includes(n))
    if (hit) used.add(hit)
    return hit ?? null
  })
}

export type RawRow = Partial<Record<ImportColumn, string>>

export interface ParsedRow {
  person: z.output<typeof personFields>
  agent: z.output<typeof agentFields> | null
  terms: z.output<typeof engagementTerms>
}

export type RowParse = { ok: true; value: ParsedRow } | { ok: false; errors: string[] }

const TRUE_WORDS = new Set(['y', 'yes', 'true', 'x', '1', 'provided', 'included'])
const FALSE_WORDS = new Set(['', 'n', 'no', 'false', '0', 'none', 'not provided', 'n a', 'na'])

export function parseBool(raw: string | undefined): boolean | null {
  const n = normalize(raw ?? '')
  if (TRUE_WORDS.has(n)) return true
  if (FALSE_WORDS.has(n)) return false
  return null
}

/** "$1,250.00" -> 125000 cents. Empty -> null. Anything else -> undefined (an error). */
export function parseMoney(raw: string | undefined): number | null | undefined {
  const s = (raw ?? '').trim()
  if (!s) return null
  const cleaned = s.replace(/[$,\s]/g, '').replace(/\/(wk|week)$/i, '')
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return undefined
  return Math.round(Number(cleaned) * 100)
}

/** "10%", "10" -> 10. "no", "" -> null (no commission). Anything else -> undefined. */
export function parsePercent(raw: string | undefined): number | null | undefined {
  const s = (raw ?? '').trim()
  if (parseBool(s) === false) return null
  const cleaned = s.replace(/%$/, '').trim()
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return undefined
  const n = Number(cleaned)
  return n <= 100 ? n : undefined
}

/** YYYY-MM-DD, M/D/YYYY or M/D/YY (20xx). Empty -> null. Anything else -> undefined. */
export function parseDate(raw: string | undefined): string | null | undefined {
  const s = (raw ?? '').trim()
  if (!s) return null
  let y: number, m: number, d: number
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(s)
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])]
  else if (us) [m, d, y] = [Number(us[1]), Number(us[2]), us[3]!.length === 2 ? 2000 + Number(us[3]) : Number(us[3])]
  else return undefined
  const date = new Date(Date.UTC(y, m - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return undefined
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

export function parseContractType(raw: string | undefined): ContractType | undefined {
  const n = normalize(raw ?? '')
  if (!n) return undefined
  if (n.includes('sdc')) return 'sdc'
  if (n.includes('non') || n === 'nu') return 'non_union'
  if (n.includes('equity') || n.includes('itc') || n.includes('aea')) return 'equity_itc'
  return CONTRACT_TYPES.find((t) => normalize(CONTRACT_TYPE_LABELS[t]) === n)
}

export function parsePipelineStatus(raw: string | undefined): PipelineStatus | null | undefined {
  const n = normalize(raw ?? '')
  if (!n) return null
  return PIPELINE_STATUSES.find((s) => normalize(PIPELINE_LABELS[s]) === n || normalize(s) === n)
}

/** Turns one mapped spreadsheet row into a person, an agent and terms, or the reasons it can't. */
export function parseImportRow(raw: RawRow): RowParse {
  const errors: string[] = []
  const text = (k: ImportColumn) => {
    const v = raw[k]?.trim()
    return v ? v : null
  }
  const bool = (k: ImportColumn, label: string) => {
    const v = parseBool(raw[k])
    if (v === null) errors.push(`${label}: "${raw[k]}" isn't yes or no.`)
    return v ?? false
  }
  const money = (k: ImportColumn, label: string) => {
    const v = parseMoney(raw[k])
    if (v === undefined) errors.push(`${label}: "${raw[k]}" isn't an amount.`)
    return v ?? null
  }
  const date = (k: ImportColumn, label: string) => {
    const v = parseDate(raw[k])
    if (v === undefined) errors.push(`${label}: "${raw[k]}" isn't a date.`)
    return v ?? null
  }

  if (!text('legalName')) errors.push('Legal name is required.')
  if (!text('role')) errors.push('Role is required.')
  const contractType = parseContractType(raw.contractType)
  if (!contractType) errors.push(`Contract type: "${raw.contractType ?? ''}" isn't Equity ITC, SDC or non-union.`)
  const commission = parsePercent(raw.commissionPercent)
  if (commission === undefined) errors.push(`Commission: "${raw.commissionPercent}" isn't a percent.`)
  const status = parsePipelineStatus(raw.pipelineStatus)
  if (status === undefined) errors.push(`Status: "${raw.pipelineStatus}" isn't a pipeline stage.`)

  const candidate = {
    person: {
      legalName: text('legalName') ?? '',
      preferredName: text('preferredName'),
      email: text('email'),
      cell: text('cell'),
      homeAirport: text('homeAirport')?.toUpperCase() ?? null,
    },
    agent: text('agentName')
      ? { name: text('agentName'), agency: text('agency'), email: text('agentEmail'), phone: text('agentPhone') }
      : null,
    terms: {
      role: text('role') ?? '',
      contractType: contractType ?? 'non_union',
      pipelineStatus: status ?? 'offer_accepted',
      weeklyPayCents: money('weeklyPay', 'Weekly pay'),
      commissionPercent: commission ?? null,
      weeklyStipendCents: money('weeklyStipend', 'Weekly stipend'),
      travelProvided: bool('travelProvided', 'Travel provided'),
      carProvided: bool('carProvided', 'Rental car provided'),
      housingProvided: bool('housingProvided', 'Housing provided'),
      preferredArrival: date('preferredArrival', 'Preferred arrival'),
      preferredDeparture: date('preferredDeparture', 'Preferred departure'),
      notes: text('notes'),
    },
  }
  if (!candidate.agent && (text('agency') || text('agentEmail') || text('agentPhone'))) {
    errors.push('Agent: an agency, email or phone is given without the agent’s name.')
  }

  // Required fields already have their own message above.
  const report = (path: PropertyKey | undefined, message: string) => {
    if ((path === 'legalName' && !text('legalName')) || (path === 'role' && !text('role'))) return
    errors.push(`${labelFor(path)}: ${message}`)
  }
  const p = personFields.safeParse(candidate.person)
  if (!p.success) for (const i of p.error.issues) report(i.path[0], i.message)
  const t = engagementTerms.safeParse(candidate.terms)
  if (!t.success) for (const i of t.error.issues) report(i.path[0], i.message)
  const a = candidate.agent ? agentFields.safeParse(candidate.agent) : null
  if (a && !a.success) for (const i of a.error.issues) errors.push(`Agent ${String(i.path[0])}: ${i.message}`)
  const { preferredArrival: arr, preferredDeparture: dep } = candidate.terms
  if (arr && dep && arr > dep) errors.push('Preferred departure is before preferred arrival.')

  if (errors.length || !p.success || !t.success || (a && !a.success)) return { ok: false, errors: [...new Set(errors)] }
  return { ok: true, value: { person: p.data, agent: a?.success ? a.data : null, terms: t.data } }
}

function labelFor(key: PropertyKey | undefined): string {
  const map: Record<string, string> = {
    legalName: 'Legal name',
    role: 'Role',
    email: 'Email',
    homeAirport: 'Home airport',
  }
  return map[String(key)] ?? String(key)
}
