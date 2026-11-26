import type { AnyFieldApi } from '@tanstack/react-form'
import type { ReactNode } from 'react'
import {
  Checkbox,
  CONTRACT_OPTIONS,
  moneyValidator,
  percentValidator,
  PIPELINE_OPTIONS,
  Select,
  TextArea,
  TextInput,
} from '../lib/fields'

/** The slice of a TanStack form these fieldsets need: its Field component. */
export interface HasField {
  Field: React.ComponentType<{
    name: string
    validators?: { onChange?: (arg: { value: string }) => string | undefined }
    children: (field: AnyFieldApi) => ReactNode
  }>
}

/** Validator for a field that can't be left blank. */
export const required = ({ value }: { value: string }) => (value.trim() ? undefined : 'Required')

type Part = 'role' | 'pay' | 'commission' | 'logistics' | 'extras'

/**
 * One part of the deal terms. Forms put the parts in the order of the
 * acceptance email: role, pay, agent and commission, travel, then the rest.
 * Every field lives under `${prefix}` in the form's values (a TermsDraft).
 */
export function TermsFields({
  form,
  prefix,
  part,
  hideStatus = false,
}: {
  form: HasField
  prefix: string
  part: Part
  /** Leave out the status menu, for screens that change status elsewhere. */
  hideStatus?: boolean
}) {
  const F = form.Field
  const n = (name: string) => `${prefix}${name}`
  switch (part) {
    case 'role':
      return (
        <div className="grid">
          <F name={n('role')} validators={{ onChange: required }}>
            {(f) => <TextInput field={f} label="Role or position" placeholder="e.g. Lead, Director" />}
          </F>
          <F name={n('contractType')}>{(f) => <Select field={f} label="Contract type" options={CONTRACT_OPTIONS} />}</F>
        </div>
      )
    case 'pay':
      return (
        <div className="grid">
          <F name={n('weeklyPay')} validators={{ onChange: moneyValidator }}>
            {(f) => <TextInput field={f} label="Weekly pay ($)" inputMode="decimal" />}
          </F>
          <F name={n('weeklyStipend')} validators={{ onChange: moneyValidator }}>
            {(f) => (
              <TextInput field={f} label="Weekly stipend ($)" inputMode="decimal" hint="Negotiated, non-taxable" />
            )}
          </F>
          <F name={n('fee')} validators={{ onChange: moneyValidator }}>
            {(f) => (
              <TextInput field={f} label="Flat fee ($)" inputMode="decimal" hint="SDC directors and choreographers" />
            )}
          </F>
        </div>
      )
    case 'commission':
      return (
        <div className="grid">
          <F name={n('commission')} validators={{ onChange: percentValidator }}>
            {(f) => (
              <TextInput field={f} label="Agent commission (%)" inputMode="decimal" hint="Leave empty for none" />
            )}
          </F>
        </div>
      )
    case 'logistics':
      return (
        <>
          <div className="checks">
            <F name={n('travelProvided')}>{(f) => <Checkbox field={f} label="Travel provided" />}</F>
            <F name={n('carProvided')}>{(f) => <Checkbox field={f} label="Rental car provided" />}</F>
            <F name={n('housingProvided')}>{(f) => <Checkbox field={f} label="Housing provided" />}</F>
          </div>
          <div className="grid">
            <F name={n('preferredArrival')}>{(f) => <TextInput field={f} type="date" label="Preferred arrival" />}</F>
            <F name={n('preferredDeparture')}>
              {(f) => <TextInput field={f} type="date" label="Preferred departure" />}
            </F>
          </div>
        </>
      )
    case 'extras':
      return (
        <div className="grid">
          {hideStatus ? null : (
            <F name={n('pipelineStatus')}>{(f) => <Select field={f} label="Status" options={PIPELINE_OPTIONS} />}</F>
          )}
          <F name={n('compAllotment')}>
            {(f) => <TextInput field={f} type="number" label="Comp tickets" min={0} max={20} />}
          </F>
          <F name={n('scriptNeeded')}>{(f) => <Checkbox field={f} label="Printed script needed" />}</F>
          <F name={n('notes')}>{(f) => <TextArea field={f} label="Notes" />}</F>
        </div>
      )
  }
}
