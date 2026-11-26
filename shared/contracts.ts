/**
 * Contracts: templates, the union forms' field maps, and what each field is
 * filled with. Shared by the server (which fills and checks the PDFs) and the
 * client (which shows the same values and blanks before anything is
 * downloaded or marked sent).
 *
 * The union forms are used as published: the Company Manager uploads the
 * blank fillable PDF, the app fills its named fields and leaves every word of
 * the form alone. Equity's ITC contract and the SDC tier agreement each get a
 * built-in map below. A text template (the Theatre Raleigh ITC rider) is a
 * body with {{tokens}}, rendered to a plain PDF.
 *
 * Nothing here e-signs. Signatures and signing dates are left for people to
 * fill by hand, and a signed copy is marked signed in the app.
 */
import { z } from 'zod'
import type { FieldMap } from './access.js'
import { CONTRACT_TYPES, isoDate, optionalText, trimmed, type ContractType } from './roster.js'

// ---------------------------------------------------------------------------
// Enums and registries
// ---------------------------------------------------------------------------

/** How a template is turned into a contract. */
export const TEMPLATE_FORMATS = ['equity_itc_form', 'sdc_form', 'text'] as const
export type TemplateFormat = (typeof TEMPLATE_FORMATS)[number]
export type FormFormat = Exclude<TemplateFormat, 'text'>
export const TEMPLATE_FORMAT_LABELS: Record<TemplateFormat, string> = {
  equity_itc_form: 'Equity ITC contract (fillable PDF)',
  sdc_form: 'SDC tier agreement (fillable PDF)',
  text: 'Text template',
}

/** The contract type a union form belongs to. A text template's type is chosen when it's made. */
export const FORM_CONTRACT_TYPE: Record<FormFormat, ContractType> = {
  equity_itc_form: 'equity_itc',
  sdc_form: 'sdc',
}

export const CONTRACT_STATUSES = ['draft', 'sent', 'signed', 'void'] as const
export type ContractStatus = (typeof CONTRACT_STATUSES)[number]
export const CONTRACT_STATUS_LABELS: Record<ContractStatus, string> = {
  draft: 'Draft',
  sent: 'Sent',
  signed: 'Signed',
  void: 'Void',
}

/** Contracts, templates and the organization's details are all in the Contracts group. */
export const CONTRACT_FIELDS = {
  id: 'id',
  engagementId: 'id',
  templateId: 'id',
  status: 'contracts',
  overrides: 'contracts',
  sentOn: 'contracts',
  sentTo: 'contracts',
  signedOn: 'contracts',
  voidedAt: 'contracts',
} as const satisfies FieldMap

export const TEMPLATE_FIELDS = {
  id: 'id',
  familyId: 'id',
  name: 'contracts',
  format: 'contracts',
  contractType: 'contracts',
  version: 'contracts',
  fileName: 'contracts',
  body: 'contracts',
  active: 'contracts',
} as const satisfies FieldMap

export const ORGANIZATION_FIELDS = {
  name: 'contracts',
  street: 'contracts',
  cityStateZip: 'contracts',
  phone: 'contracts',
  email: 'contracts',
  signerName: 'contracts',
  ein: 'contracts',
  unemploymentNumber: 'contracts',
  equityEmployerAgreement: 'contracts',
} as const satisfies FieldMap

export const ORGANIZATION_LABELS: Record<keyof typeof ORGANIZATION_FIELDS, string> = {
  name: 'Producing organization',
  street: 'Street address',
  cityStateZip: 'City, state, ZIP',
  phone: 'Phone',
  email: 'Contracts email',
  signerName: 'Who signs for the theatre',
  ein: 'Employer registration (EIN)',
  unemploymentNumber: 'Unemployment insurance number and state',
  equityEmployerAgreement: 'Equity employer agreement number',
}

// ---------------------------------------------------------------------------
// What a contract is filled from
// ---------------------------------------------------------------------------

export interface OrganizationValues {
  name: string | null
  street: string | null
  cityStateZip: string | null
  phone: string | null
  email: string | null
  signerName: string | null
  ein: string | null
  unemploymentNumber: string | null
  equityEmployerAgreement: string | null
}

export interface ContractContext {
  /** The day the contract is prepared or sent, YYYY-MM-DD. */
  today: string
  employer: OrganizationValues
  person: {
    legalName: string
    unionMemberId: string | null
    email: string | null
    cell: string | null
    /** Personal ID. Present only on the server, when a PDF is made. */
    homeStreet: string | null
    homeCityStateZip: string | null
  }
  engagement: {
    role: string
    weeklyPayCents: number | null
    weeklyStipendCents: number | null
    feeCents: number | null
  }
  production: {
    title: string
    rehearsalStart: string | null
    opening: string | null
    closing: string | null
    venueName: string | null
    venueCapacity: number | null
    topTicketCents: number | null
    scheduledPerformances: number | null
    rehearsalLocation: string | null
    rehearsalCallTime: string | null
  }
  season: { name: string }
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

function parts(iso: string | null): { y: number; m: number; d: number } | null {
  if (!iso) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!match) return null
  return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) }
}

function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`
}

/** "June 1", for forms that print the year in its own box. */
export function monthDay(iso: string | null): string {
  const p = parts(iso)
  return p ? `${MONTHS[p.m - 1]} ${p.d}` : ''
}
/** "27": the forms print "20__" and leave the last two digits. */
export function shortYear(iso: string | null): string {
  const p = parts(iso)
  return p ? String(p.y % 100).padStart(2, '0') : ''
}
/** "June 1, 2027". */
export function longDate(iso: string | null): string {
  const p = parts(iso)
  return p ? `${MONTHS[p.m - 1]} ${p.d}, ${p.y}` : ''
}
export function dayOrdinal(iso: string | null): string {
  const p = parts(iso)
  return p ? ordinal(p.d) : ''
}
export function monthName(iso: string | null): string {
  const p = parts(iso)
  return p ? MONTHS[p.m - 1]! : ''
}

/** "1,050.00". */
export function money(cents: number | null): string {
  if (cents === null) return ''
  return (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const ONES = [
  '',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
]
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

function underThousand(n: number): string {
  const out: string[] = []
  if (n >= 100) {
    out.push(`${ONES[Math.floor(n / 100)]} hundred`)
    n %= 100
  }
  if (n >= 20) {
    out.push(n % 10 ? `${TENS[Math.floor(n / 10)]}-${ONES[n % 10]}` : TENS[Math.floor(n / 10)]!)
  } else if (n > 0) {
    out.push(ONES[n]!)
  }
  return out.join(' ')
}

/** "One thousand fifty dollars", or "... and 50/100 dollars" with cents. For the ITC's written-out pay. */
export function moneyInWords(cents: number | null): string {
  if (cents === null) return ''
  const dollars = Math.floor(cents / 100)
  const rest = cents % 100
  const words: string[] = []
  let n = dollars
  const scales: [number, string][] = [
    [1_000_000, 'million'],
    [1_000, 'thousand'],
  ]
  for (const [size, name] of scales) {
    if (n >= size) {
      words.push(`${underThousand(Math.floor(n / size))} ${name}`)
      n %= size
    }
  }
  if (n > 0 || words.length === 0) words.push(n === 0 ? 'zero' : underThousand(n))
  let text = words.join(' ')
  if (rest) text += ` and ${String(rest).padStart(2, '0')}/100`
  text += ' dollars'
  return text[0]!.toUpperCase() + text.slice(1)
}

// ---------------------------------------------------------------------------
// SDC tier. The agreement works this out with JavaScript inside the PDF; a
// filled PDF doesn't run it, so the app does the same arithmetic.
// ---------------------------------------------------------------------------

export function capacityBand(seats: number | null): number | null {
  if (!seats) return null
  if (seats < 100) return 1
  if (seats <= 150) return 2
  if (seats <= 199) return 3
  if (seats <= 299) return 4
  if (seats <= 399) return 5
  if (seats <= 499) return 6
  return 7
}

/** Whole-dollar top ticket price. */
export function ticketBand(dollars: number | null): number | null {
  if (dollars === null) return null
  if (dollars <= 20) return 1
  if (dollars <= 25) return 2
  if (dollars <= 29) return 3
  if (dollars <= 39) return 4
  if (dollars <= 49) return 5
  if (dollars <= 59) return 6
  return 7
}

export function performancesBand(count: number | null): number | null {
  if (!count) return null
  if (count <= 10) return 1
  if (count <= 20) return 2
  if (count <= 24) return 3
  if (count <= 29) return 4
  if (count <= 34) return 5
  if (count <= 39) return 6
  return 7
}

export interface SdcTier {
  capacity: number
  ticket: number
  performances: number
  /** The average of the three bands, as the form shows it (a whole number). */
  tier: number
  /** Weekly health contribution in cents, or null when SDC sets it (the top tier). */
  healthCents: number | null
}

export function sdcTier(p: ContractContext['production']): SdcTier | null {
  const capacity = capacityBand(p.venueCapacity)
  const ticket = ticketBand(p.topTicketCents === null ? null : Math.floor(p.topTicketCents / 100))
  const performances = performancesBand(p.scheduledPerformances)
  if (capacity === null || ticket === null || performances === null) return null
  const average = (capacity + ticket + performances) / 3
  const health =
    average < 1.5
      ? 375_00
      : average < 2.5
        ? 675_00
        : average < 3.5
          ? 900_00
          : average < 4.5
            ? 1000_00
            : average < 5.5
              ? 1250_00
              : average < 6.5
                ? 1450_00
                : null
  return { capacity, ticket, performances, tier: Math.round(average), healthCents: health }
}

/** SDC pension is 10% of the fee. */
export function sdcPensionCents(feeCents: number | null): number | null {
  return feeCents === null ? null : Math.round(feeCents * 0.1)
}

export const SDC_ROLES = [
  'Director',
  'Choreographer',
  'Director/Choreographer',
  'Fight Choreographer',
  'Short-Term Choreographer',
  'Short-Term Fight Choreographer',
] as const

/** The SDC form's role from the engagement's role, when it's one of the form's choices. */
export function sdcRole(role: string): string {
  const r = role.trim().toLowerCase()
  const exact = SDC_ROLES.find((o) => o.toLowerCase() === r)
  if (exact) return exact
  if (/fight/.test(r)) return 'Fight Choreographer'
  if (/director/.test(r) && /choreo/.test(r)) return 'Director/Choreographer'
  if (/choreo/.test(r)) return 'Choreographer'
  if (/^director$|stage director/.test(r)) return 'Director'
  return ''
}

export const ITC_DUTIES = ['Principal', 'Chorus', 'SM'] as const

/** The ITC's checkbox: stage managers are SM, everyone else Principal unless changed to Chorus. */
export function itcDuty(role: string): string {
  return /stage manager|\bsm\b|\basm\b/i.test(role) ? 'SM' : 'Principal'
}

/** "Raleigh, NC 27601" into its ZIP and the rest, for forms that ask for them apart. */
export function splitZip(cityStateZip: string | null): { rest: string; zip: string } {
  if (!cityStateZip) return { rest: '', zip: '' }
  const m = /^(.*?)[,\s]+(\d{5}(?:-\d{4})?)\s*$/.exec(cityStateZip.trim())
  return m ? { rest: m[1]!.trim(), zip: m[2]! } : { rest: cityStateZip.trim(), zip: '' }
}

// ---------------------------------------------------------------------------
// Field maps for the union forms. Names are the forms' own field names.
// Signature and signing-date fields aren't listed: they're filled by hand.
// ---------------------------------------------------------------------------

export interface FormField {
  /** The PDF form field's name. */
  name: string
  label: string
  kind: 'text' | 'choice' | 'checkbox'
  /** The choices a radio group or dropdown takes. */
  options?: readonly string[]
  value: (c: ContractContext) => string
  /** A contract can't be marked sent while this is blank. */
  required: boolean
  /** Filled from Personal ID: never shown in the app, never stored with the contract. */
  personal?: boolean
  /** Worked out by the app (the SDC tier math); can't be typed over. */
  computed?: boolean
  /** From the person's Contact group (email, cell): shown and printed only with Contact access. */
  contact?: boolean
}

const text = (
  name: string,
  label: string,
  value: FormField['value'],
  opts: Partial<Pick<FormField, 'required' | 'personal' | 'computed' | 'contact'>> = {},
): FormField => ({ name, label, kind: 'text', value, required: opts.required ?? true, ...opts })

export const ITC_FIELDS: readonly FormField[] = [
  text('EmployerAgreement', 'Equity employer agreement number', (c) => c.employer.equityEmployerAgreement ?? ''),
  {
    name: 'Duty',
    label: 'Principal, Chorus or Stage Manager',
    kind: 'choice',
    options: ITC_DUTIES,
    value: (c) => itcDuty(c.engagement.role),
    required: true,
  },
  text('AgreementDay', 'Agreement day', (c) => dayOrdinal(c.today)),
  text('AgreementMonth', 'Agreement month', (c) => monthName(c.today)),
  text('AgreementYear', 'Agreement year (two digits)', (c) => shortYear(c.today)),
  text('Employee', 'Employee name', (c) => c.person.legalName),
  text('PartDuty', 'Part or duty', (c) => c.engagement.role),
  text('Production', 'Production', (c) => c.production.title),
  text('PartDuty_2', 'Second part or duty', () => '', { required: false }),
  text('Production 1', 'Second production', () => '', { required: false }),
  text('PartDuty_3', 'Third part or duty', () => '', { required: false }),
  text('Production 2', 'Third production', () => '', { required: false }),
  text('TheatreName', 'Theatre', (c) => c.production.venueName ?? ''),
  text('RehearsalCall', 'Rehearsal call location', (c) => c.production.rehearsalLocation ?? ''),
  text('StartDateMonthDay', 'Employment begins', (c) => monthDay(c.production.rehearsalStart)),
  text('StartDateYear', 'Employment begins, year', (c) => shortYear(c.production.rehearsalStart)),
  text('StateDateTime', 'First call time (AM or PM)', (c) => c.production.rehearsalCallTime ?? ''),
  text('FirstPerformanceMonthDay', 'First paid performance', (c) => monthDay(c.production.opening)),
  text('FirstPerformanceYear', 'First paid performance, year', (c) => shortYear(c.production.opening)),
  text('TerminationMonthDay', 'Contract ends', (c) => monthDay(c.production.closing), { required: false }),
  text('The', 'Contract ends, year', (c) => shortYear(c.production.closing), { required: false }),
  text('CompensationLong', 'Weekly pay in words', (c) => moneyInWords(c.engagement.weeklyPayCents)),
  text('CompensationShort', 'Weekly pay', (c) => money(c.engagement.weeklyPayCents)),
  text('Employer', 'Producing organization', (c) => c.employer.name ?? ''),
  text('EmployerAddress', 'Theatre address', (c) => c.employer.street ?? ''),
  text('EmployerCityStateZip', 'Theatre city, state, ZIP', (c) => c.employer.cityStateZip ?? ''),
  text('Unemployment', 'Unemployment insurance number and state', (c) => c.employer.unemploymentNumber ?? ''),
  text('EmployeeAddress', 'Employee home address', (c) => c.person.homeStreet ?? '', { personal: true }),
  text('EmployeeCityStateZip', 'Employee city, state, ZIP', (c) => c.person.homeCityStateZip ?? '', {
    personal: true,
  }),
  text('EmployeeEmail', 'Employee email', (c) => c.person.email ?? '', { contact: true }),
  text('MemberIDorSSN', 'Equity member ID', (c) => c.person.unionMemberId ?? ''),
]

const tierOf = (c: ContractContext) => sdcTier(c.production)

export const SDC_FIELDS: readonly FormField[] = [
  text('day', 'Agreement day', (c) => dayOrdinal(c.today)),
  text('month', 'Agreement month', (c) => monthName(c.today)),
  text('year', 'Agreement year (two digits)', (c) => shortYear(c.today)),
  text('Employer', 'Producing organization', (c) => c.employer.name ?? ''),
  text('Artist', 'Artist', (c) => c.person.legalName),
  {
    name: 'Role',
    label: 'SDC role',
    kind: 'choice',
    options: SDC_ROLES,
    value: (c) => sdcRole(c.engagement.role),
    required: true,
  },
  text('production', 'Production', (c) => c.production.title),
  text('first reh', 'First rehearsal', (c) => longDate(c.production.rehearsalStart)),
  text('first perf', 'First performance', (c) => longDate(c.production.opening)),
  text('closing', 'Closing', (c) => longDate(c.production.closing)),
  text('Venue Name', 'Venue', (c) => c.production.venueName ?? ''),
  text('Venue capacity', 'Venue capacity', (c) =>
    c.production.venueCapacity ? String(c.production.venueCapacity) : '',
  ),
  text('Top Ticket $', 'Top ticket price', (c) =>
    c.production.topTicketCents === null ? '' : String(Math.floor(c.production.topTicketCents / 100)),
  ),
  text('Sched perfs', 'Scheduled performances', (c) =>
    c.production.scheduledPerformances ? String(c.production.scheduledPerformances) : '',
  ),
  text('Venue capacity hid', 'Capacity band', (c) => String(tierOf(c)?.capacity ?? ''), {
    required: false,
    computed: true,
  }),
  text('top ticket hid', 'Ticket band', (c) => String(tierOf(c)?.ticket ?? ''), { required: false, computed: true }),
  text('Sched perfs hid', 'Performances band', (c) => String(tierOf(c)?.performances ?? ''), {
    required: false,
    computed: true,
  }),
  text('Tier', 'Tier', (c) => String(tierOf(c)?.tier ?? ''), { computed: true }),
  text('Compensation', 'Fee', (c) => money(c.engagement.feeCents)),
  text('Pension', 'Pension (10% of fee)', (c) => money(sdcPensionCents(c.engagement.feeCents)), { computed: true }),
  text(
    'Health',
    'Health (the top tier is set by SDC)',
    (c) => {
      const t = tierOf(c)
      return t?.healthCents ? money(t.healthCents) : ''
    },
    { computed: true },
  ),
  text('Please print name', 'Artist name (print)', (c) => c.person.legalName),
  text('Address 1', 'Artist home address', (c) => c.person.homeStreet ?? '', { personal: true }),
  text('Address 2', 'Artist city and state', (c) => splitZip(c.person.homeCityStateZip).rest, { personal: true }),
  text('Zip', 'Artist ZIP', (c) => splitZip(c.person.homeCityStateZip).zip, { personal: true }),
  text('Phone', 'Artist phone', (c) => c.person.cell ?? '', { required: false, contact: true }),
  text('Email Address', 'Artist email', (c) => c.person.email ?? '', { contact: true }),
  // The member ID on file may be Equity's, so it can't say whether someone is
  // in SDC. Both boxes start unticked; the company manager ticks one.
  {
    name: 'Check Box1',
    label: 'SDC member: yes',
    kind: 'checkbox',
    value: () => '',
    required: false,
  },
  {
    name: 'Check Box2',
    label: 'SDC member: no',
    kind: 'checkbox',
    value: () => '',
    required: false,
  },
  text('Please print name_2', 'Signing for the theatre (print)', (c) => c.employer.signerName ?? ''),
  text('Address 1_2', 'Theatre address', (c) => c.employer.street ?? ''),
  text('Address 2_2', 'Theatre city and state', (c) => splitZip(c.employer.cityStateZip).rest),
  text('Text1', 'Theatre ZIP', (c) => splitZip(c.employer.cityStateZip).zip),
  text('Phone_2', 'Theatre phone', (c) => c.employer.phone ?? '', { required: false }),
  text('Email Address_2', 'Theatre email', (c) => c.employer.email ?? ''),
  text('Employer Registration No', 'Employer registration (EIN)', (c) => c.employer.ein ?? ''),
]

export const FORM_FIELDS: Record<FormFormat, readonly FormField[]> = {
  equity_itc_form: ITC_FIELDS,
  sdc_form: SDC_FIELDS,
}

/**
 * Field names that tell the two forms apart, and every field the map needs.
 * A different edition of a form that renames a field is caught at upload.
 */
export const FORM_SIGNATURES: Record<FormFormat, readonly string[]> = {
  equity_itc_form: ['EmployerAgreement', 'MemberIDorSSN'],
  sdc_form: ['Venue capacity', 'Tier'],
}

/** Signature fields on each form. Never filled; listed so a stand-in form can draw them. */
export const SIGNATURE_FIELDS: Record<FormFormat, readonly string[]> = {
  equity_itc_form: ['ProducersSignature', 'EmployeeSignature'],
  sdc_form: ['Signature', 'Date', 'By Signature', 'Date_2'],
}

// ---------------------------------------------------------------------------
// Text templates
// ---------------------------------------------------------------------------

export interface TemplateToken {
  label: string
  value: (c: ContractContext) => string
  /** From the person's Contact group: shown and printed only with Contact access. */
  contact?: boolean
}

/** What a text template can say with {{token}}. Personal ID never goes in a text template. */
export const TEXT_TOKENS: Record<string, TemplateToken> = {
  'employee.name': { label: 'Employee name', value: (c) => c.person.legalName },
  'employee.member_id': { label: 'Union member ID', value: (c) => c.person.unionMemberId ?? '' },
  'employee.email': { label: 'Employee email', value: (c) => c.person.email ?? '', contact: true },
  role: { label: 'Role', value: (c) => c.engagement.role },
  production: { label: 'Production', value: (c) => c.production.title },
  season: { label: 'Season', value: (c) => c.season.name },
  venue: { label: 'Venue', value: (c) => c.production.venueName ?? '' },
  first_rehearsal: { label: 'First rehearsal', value: (c) => longDate(c.production.rehearsalStart) },
  opening: { label: 'Opening', value: (c) => longDate(c.production.opening) },
  closing: { label: 'Closing', value: (c) => longDate(c.production.closing) },
  weekly_pay: { label: 'Weekly pay', value: (c) => money(c.engagement.weeklyPayCents) },
  weekly_stipend: { label: 'Weekly stipend', value: (c) => money(c.engagement.weeklyStipendCents) },
  fee: { label: 'Flat fee', value: (c) => money(c.engagement.feeCents) },
  'employer.name': { label: 'Producing organization', value: (c) => c.employer.name ?? '' },
  'employer.signer': { label: 'Who signs for the theatre', value: (c) => c.employer.signerName ?? '' },
  'employer.unemployment': {
    label: 'Unemployment insurance number',
    value: (c) => c.employer.unemploymentNumber ?? '',
  },
  'employer.agreement': {
    label: 'Equity employer agreement number',
    value: (c) => c.employer.equityEmployerAgreement ?? '',
  },
  today: { label: 'Date prepared', value: (c) => longDate(c.today) },
}

const TOKEN = /\{\{\s*([a-z_.]+)\s*\}\}/g

/** Tokens a body uses, in order of first use. */
export function tokensIn(body: string): string[] {
  const seen = new Set<string>()
  for (const m of body.matchAll(TOKEN)) seen.add(m[1]!)
  return [...seen]
}

/** A real token, not something every object has (like constructor or toString). */
export function isToken(name: string): boolean {
  return Object.hasOwn(TEXT_TOKENS, name)
}

export function unknownTokens(body: string): string[] {
  return tokensIn(body).filter((t) => !isToken(t))
}

export function mergeBody(body: string, values: Record<string, string>): string {
  return body.replace(TOKEN, (_all, name: string) => values[name] || '________')
}

// ---------------------------------------------------------------------------
// Resolving a contract: every field's value, the overrides typed on top, and
// what's still blank.
// ---------------------------------------------------------------------------

export interface ResolvedField {
  name: string
  label: string
  kind: FormField['kind']
  options?: readonly string[]
  value: string
  required: boolean
  personal: boolean
  computed: boolean
  contact: boolean
  overridden: boolean
}

export type Overrides = Record<string, string>

/** Every fillable field or token of a template, with the value it gets. */
export function resolveContract(
  template: { format: TemplateFormat; body: string | null },
  c: ContractContext,
  overrides: Overrides,
): ResolvedField[] {
  if (template.format === 'text') {
    return tokensIn(template.body ?? '')
      .filter(isToken)
      .map((t) => {
        const token = TEXT_TOKENS[t]!
        const typed = overrides[t]
        return {
          name: t,
          label: token.label,
          kind: 'text',
          value: typed ?? token.value(c),
          required: true,
          personal: false,
          computed: false,
          contact: Boolean(token.contact),
          overridden: typed !== undefined,
        }
      })
  }
  return FORM_FIELDS[template.format].map((f) => {
    const typed = f.personal || f.computed ? undefined : overrides[f.name]
    return {
      name: f.name,
      label: f.label,
      kind: f.kind,
      options: f.options,
      value: typed ?? f.value(c),
      required: f.required,
      personal: Boolean(f.personal),
      computed: Boolean(f.computed),
      contact: Boolean(f.contact),
      overridden: typed !== undefined,
    }
  })
}

/** The fields or tokens of a template that come from the person's Contact group. */
export function contactFieldNames(template: { format: TemplateFormat; body: string | null }): Set<string> {
  if (template.format === 'text') {
    return new Set(tokensIn(template.body ?? '').filter((t) => isToken(t) && TEXT_TOKENS[t]!.contact))
  }
  return new Set(FORM_FIELDS[template.format].filter((f) => f.contact).map((f) => f.name))
}

/** Required fields that would go out blank. A contract can't be marked sent until this is empty. */
export function blankFields(fields: readonly ResolvedField[]): ResolvedField[] {
  return fields.filter((f) => f.required && !f.value.trim())
}

/**
 * Which fields an override may set: not Personal ID (that's changed on the
 * person), not the tier math, and a choice only to one of its options.
 * Returns a reason, or null when the override is fine.
 */
export function overrideProblem(
  template: { format: TemplateFormat; body: string | null },
  name: string,
  value: string,
): string | null {
  if (template.format === 'text') {
    return tokensIn(template.body ?? '').includes(name) && isToken(name) ? null : `This template has no ${name}.`
  }
  const field = FORM_FIELDS[template.format].find((f) => f.name === name)
  if (!field) return `This form has no field named ${name}.`
  if (field.personal) return `${field.label} comes from the person's profile. Change it there.`
  if (field.computed) return `${field.label} is worked out from the production's venue numbers.`
  if (field.kind === 'choice' && value && !field.options?.includes(value)) {
    return `${field.label} must be one of: ${field.options?.join(', ')}.`
  }
  if (field.kind === 'checkbox' && value !== '' && value !== 'yes') return `${field.label} is a checkbox.`
  return null
}

/** The templates that apply to an engagement's contract type. */
export function templateApplies(t: { contractType: ContractType; active: boolean }, type: ContractType): boolean {
  return t.active && t.contractType === type
}

// ---------------------------------------------------------------------------
// The default rider. Written for the demo with placeholder terms: the real
// rider's rates and names come from the theatre's own agreement with Equity,
// which the Company Manager pastes in.
// ---------------------------------------------------------------------------

export const DEFAULT_RIDER_BODY = `# Standard ITC Rider
Must be attached to each individual employment contract.

The attached employment contract and this rider are governed by the Independent Theatre Contract (ITC), except as modified by this rider between Actors' Equity Association and {{employer.name}} for the productions in the {{season}} at {{venue}}.

# 1. Minimum weekly salaries
Actor: $[minimum]   Stage Manager: $[minimum]   Assistant Stage Manager: $[minimum]

# 2. Performances and rehearsals
All rehearsals and performances are scheduled in accordance with the Agreement and Rules Governing Employment in the ITC. [Workweek hours, days off, tech and dress rehearsal limits as agreed with Equity.]

# 3. Housing and per diem
[Housing, transportation and per diem terms as agreed with Equity.]

# 4. Health and pension
[Weekly health contribution and pension rate as agreed with Equity.]

# 5. Other terms and conditions
[Any other terms in the theatre's rider.]

# Agreed: Employee
Employee: {{employee.name}}
Part or duty: {{role}} in {{production}}
AEA member ID: {{employee.member_id}}

Employee signature: ______________________________   Date: ____________

# Agreed: {{employer.name}}
{{employer.signer}}, Employer
Unemployment insurance number: {{employer.unemployment}}

Employer signature: ______________________________   Date: ____________
`

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const overridesSchema = z.record(z.string().min(1).max(80), z.string().max(500))

export const prepareContractsInput = z.object({ engagementId: z.uuid() })

export const setOverridesInput = z.object({ id: z.uuid(), overrides: overridesSchema })

export const markSentInput = z.object({
  id: z.uuid(),
  sentOn: isoDate,
  /** Who it went to, in words ("Riley and their agent"). */
  sentTo: trimmed(300),
})

export const markSignedInput = z.object({ id: z.uuid(), signedOn: isoDate })

export const organizationInput = z.object({
  name: optionalText(160),
  street: optionalText(200),
  cityStateZip: optionalText(200),
  phone: optionalText(40),
  email: z
    .email()
    .nullable()
    .optional()
    .or(z.literal('').transform(() => null)),
  signerName: optionalText(160),
  ein: optionalText(20),
  unemploymentNumber: optionalText(60),
  equityEmployerAgreement: optionalText(40),
})

/** A blank union form, base64. Vercel takes request bodies up to 4.5 MB. */
export const uploadFormInput = z.object({
  name: trimmed(160),
  fileName: trimmed(200),
  pdfBase64: z.string().min(100).max(4_000_000),
  /** Set to replace an earlier version of the same template. */
  replacesId: z.uuid().optional(),
})

export const saveTextTemplateInput = z.object({
  name: trimmed(160),
  contractType: z.enum(CONTRACT_TYPES),
  body: z.string().trim().min(1).max(50_000),
  replacesId: z.uuid().optional(),
})
