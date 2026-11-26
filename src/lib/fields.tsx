import type { AnyFieldApi } from '@tanstack/react-form'
import { levelAtLeast, levelFor, type AccessLevel, type FieldGroup } from '../../shared/access'
import { parseMoney, parsePercent } from '../../shared/import'
import {
  CONTRACT_TYPE_LABELS,
  CONTRACT_TYPES,
  PIPELINE_LABELS,
  PIPELINE_STATUSES,
  type ContractType,
  type PipelineStatus,
} from '../../shared/roster'
import { useMe } from './useMe'

/** What the signed-in role may do with a field group. The server enforces it; this only hides controls. */
export function useCan(): (group: FieldGroup, level?: AccessLevel) => boolean {
  const me = useMe()
  const grants = me.data?.grants ?? {}
  return (group, level = 'view') => levelAtLeast(levelFor(grants, group), level)
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })

export function dollars(cents: number | null | undefined): string {
  return cents === null || cents === undefined ? '–' : usd.format(cents / 100)
}

/** Cents to the text a money input shows ("1250.00"), or empty. */
export function centsToInput(cents: number | null | undefined): string {
  return cents === null || cents === undefined ? '' : (cents / 100).toFixed(2)
}

/** "2027-03-08" to "Mar 8, 2027", without a time zone shifting the day. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '–'
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

export function displayName(p: { legalName?: string | null; preferredName?: string | null }): string {
  if (!p.legalName) return '(name hidden)'
  return p.preferredName && !p.legalName.startsWith(p.preferredName)
    ? `${p.legalName} (${p.preferredName})`
    : p.legalName
}

// ---------------------------------------------------------------------------
// Field components for TanStack Form
// ---------------------------------------------------------------------------

export function FieldErrors({ field }: { field: AnyFieldApi }) {
  const errors = field.state.meta.errors as unknown[]
  if (!errors.length) return null
  return (
    <>
      {errors.map((err, i) => (
        <span key={i} className="error">
          {typeof err === 'string' ? err : ((err as { message?: string })?.message ?? 'Invalid')}
        </span>
      ))}
    </>
  )
}

export function TextInput({
  field,
  label,
  type = 'text',
  hint,
  ...rest
}: {
  field: AnyFieldApi
  label: string
  type?: 'text' | 'email' | 'tel' | 'date' | 'number'
  hint?: string
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'>) {
  return (
    <label>
      {label}
      <input
        type={type}
        name={field.name}
        value={(field.state.value as string | undefined) ?? ''}
        onBlur={field.handleBlur}
        onChange={(e) => field.handleChange(e.target.value)}
        {...rest}
      />
      {hint ? <span className="muted small">{hint}</span> : null}
      <FieldErrors field={field} />
    </label>
  )
}

export function TextArea({ field, label }: { field: AnyFieldApi; label: string }) {
  return (
    <label className="span-all">
      {label}
      <textarea
        name={field.name}
        rows={3}
        value={(field.state.value as string | undefined) ?? ''}
        onBlur={field.handleBlur}
        onChange={(e) => field.handleChange(e.target.value)}
      />
      <FieldErrors field={field} />
    </label>
  )
}

export function Checkbox({ field, label }: { field: AnyFieldApi; label: string }) {
  return (
    <label className="inline">
      <input
        type="checkbox"
        name={field.name}
        checked={Boolean(field.state.value)}
        onBlur={field.handleBlur}
        onChange={(e) => field.handleChange(e.target.checked)}
      />
      {label}
    </label>
  )
}

export function Select<T extends string>({
  field,
  label,
  options,
}: {
  field: AnyFieldApi
  label: string
  options: readonly { value: T; label: string }[]
}) {
  return (
    <label>
      {label}
      <select
        name={field.name}
        value={field.state.value as T}
        onBlur={field.handleBlur}
        onChange={(e) => field.handleChange(e.target.value as T)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <FieldErrors field={field} />
    </label>
  )
}

export const CONTRACT_OPTIONS = CONTRACT_TYPES.map((t) => ({ value: t, label: CONTRACT_TYPE_LABELS[t] }))
export const PIPELINE_OPTIONS = PIPELINE_STATUSES.map((s) => ({ value: s, label: PIPELINE_LABELS[s] }))

// ---------------------------------------------------------------------------
// Deal terms as a form holds them (strings for inputs), and their conversion
// to what the API takes.
// ---------------------------------------------------------------------------

export interface TermsDraft {
  role: string
  contractType: ContractType
  pipelineStatus: PipelineStatus
  weeklyPay: string
  commission: string
  weeklyStipend: string
  fee: string
  travelProvided: boolean
  carProvided: boolean
  housingProvided: boolean
  preferredArrival: string
  preferredDeparture: string
  scriptNeeded: boolean
  compAllotment: string
  notes: string
}

export const EMPTY_TERMS: TermsDraft = {
  role: '',
  contractType: 'equity_itc',
  pipelineStatus: 'offer_accepted',
  weeklyPay: '',
  commission: '',
  weeklyStipend: '',
  fee: '',
  travelProvided: false,
  carProvided: false,
  housingProvided: false,
  preferredArrival: '',
  preferredDeparture: '',
  scriptNeeded: false,
  compAllotment: '2',
  notes: '',
}

export const moneyValidator = ({ value }: { value: string }) =>
  parseMoney(value) === undefined ? 'Enter an amount like 950 or 1,250.00' : undefined
export const percentValidator = ({ value }: { value: string }) =>
  parsePercent(value) === undefined ? 'Enter a percent like 10, or leave it empty for none' : undefined

/**
 * The API's terms from a draft. Pay terms go only to roles that can edit
 * them, so a form never sends fields the server would refuse. `status: false`
 * leaves the pipeline status out, for screens that change it elsewhere.
 */
export function termsFromDraft(draft: TermsDraft, opts: { payTerms: boolean; status?: boolean }) {
  const blankToNull = (s: string) => (s.trim() ? s.trim() : null)
  return {
    role: draft.role.trim(),
    contractType: draft.contractType,
    ...(opts.status === false ? {} : { pipelineStatus: draft.pipelineStatus }),
    travelProvided: draft.travelProvided,
    carProvided: draft.carProvided,
    housingProvided: draft.housingProvided,
    preferredArrival: blankToNull(draft.preferredArrival),
    preferredDeparture: blankToNull(draft.preferredDeparture),
    scriptNeeded: draft.scriptNeeded,
    compAllotment: Number(draft.compAllotment) || 0,
    notes: blankToNull(draft.notes),
    ...(opts.payTerms
      ? {
          weeklyPayCents: parseMoney(draft.weeklyPay) ?? null,
          commissionPercent: parsePercent(draft.commission) ?? null,
          weeklyStipendCents: parseMoney(draft.weeklyStipend) ?? null,
          feeCents: parseMoney(draft.fee) ?? null,
        }
      : {}),
  }
}

/** A draft from an engagement as the API returns it (fields the role can't see stay blank). */
export function draftFromEngagement(e: Partial<Record<string, unknown>>): TermsDraft {
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  return {
    role: str(e.role),
    contractType: (e.contractType as ContractType | undefined) ?? 'equity_itc',
    pipelineStatus: (e.pipelineStatus as PipelineStatus | undefined) ?? 'offer_accepted',
    weeklyPay: centsToInput(e.weeklyPayCents as number | null | undefined),
    commission: e.commissionPercent === null || e.commissionPercent === undefined ? '' : String(e.commissionPercent),
    weeklyStipend: centsToInput(e.weeklyStipendCents as number | null | undefined),
    fee: centsToInput(e.feeCents as number | null | undefined),
    travelProvided: Boolean(e.travelProvided),
    carProvided: Boolean(e.carProvided),
    housingProvided: Boolean(e.housingProvided),
    preferredArrival: str(e.preferredArrival),
    preferredDeparture: str(e.preferredDeparture),
    scriptNeeded: Boolean(e.scriptNeeded),
    compAllotment: e.compAllotment === undefined ? '2' : String(e.compAllotment),
    notes: str(e.notes),
  }
}
