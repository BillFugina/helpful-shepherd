import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import {
  CONTRACT_STATUS_LABELS,
  DEFAULT_RIDER_BODY,
  ORGANIZATION_LABELS,
  TEMPLATE_FORMAT_LABELS,
  TEXT_TOKENS,
  type ContractStatus,
  type OrganizationValues,
} from '../../shared/contracts'
import { CONTRACT_OPTIONS, displayName, formatDate, useCan } from '../lib/fields'
import { CONTRACT_TYPE_LABELS, PIPELINE_LABELS, type ContractType } from '../../shared/roster'
import { errorText } from '../lib/errors'
import { useTRPC } from '../lib/trpc'
import type { Outputs } from '../lib/types'

function StatusChip({ status }: { status: ContractStatus }) {
  return <span className={`chip contract-${status}`}>{CONTRACT_STATUS_LABELS[status]}</span>
}

function today(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
}

function saveFile(fileName: string, base64: string) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

// ---------------------------------------------------------------------------
// On the engagement page
// ---------------------------------------------------------------------------

/** The engagement's contracts, and a button to prepare the ones it doesn't have yet. */
export function EngagementContracts({ engagementId }: { engagementId: string }) {
  const trpc = useTRPC()
  const can = useCan()
  const queryClient = useQueryClient()
  const list = useQuery(trpc.contracts.forEngagement.queryOptions({ engagementId }))
  const prepare = useMutation(trpc.contracts.prepare.mutationOptions())
  if (!can('contracts')) return null

  return (
    <section className="card wide">
      <h2>Contracts</h2>
      {list.isPending ? <p className="muted">Loading…</p> : null}
      {list.error ? <p className="error">{errorText(list.error)}</p> : null}
      {list.data ? (
        <>
          {list.data.contracts.length ? (
            <ul className="plain">
              {list.data.contracts.map((c) => (
                <li key={c.id}>
                  <Link to={`/contracts/${c.id}`}>{c.template.name}</Link>{' '}
                  {c.status ? <StatusChip status={c.status} /> : null}
                  {c.sentOn ? <span className="muted small"> Sent {formatDate(c.sentOn)}</span> : null}
                  {c.signedOn ? <span className="muted small"> · Signed {formatDate(c.signedOn)}</span> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No contracts yet.</p>
          )}
          {list.data.toPrepare.length && can('contracts', 'edit') ? (
            <div className="actions">
              <button
                type="button"
                disabled={prepare.isPending}
                onClick={async () => {
                  await prepare.mutateAsync({ engagementId })
                  await queryClient.invalidateQueries({
                    queryKey: trpc.contracts.forEngagement.queryKey({ engagementId }),
                  })
                }}
              >
                {prepare.isPending ? 'Preparing…' : `Prepare ${list.data.toPrepare.map((t) => t.name).join(' and ')}`}
              </button>
            </div>
          ) : null}
          {!list.data.contracts.length && !list.data.toPrepare.length ? (
            <p className="muted small">
              There’s no contract template for this contract type.{' '}
              <Link to="/contracts/settings">Contract settings</Link>
            </p>
          ) : null}
          {prepare.error ? <p className="error">{errorText(prepare.error)}</p> : null}
        </>
      ) : null}
    </section>
  )
}

// ---------------------------------------------------------------------------
// One contract
// ---------------------------------------------------------------------------

type ContractDetail = Outputs['contracts']['get']

export function ContractPage() {
  const { contractId = '' } = useParams()
  const trpc = useTRPC()
  const detail = useQuery(trpc.contracts.get.queryOptions({ id: contractId }))
  if (detail.isPending) return <p className="muted">Loading…</p>
  if (detail.error) return <p className="error">{errorText(detail.error)}</p>
  return <ContractView detail={detail.data} />
}

function ContractView({ detail: d }: { detail: ContractDetail }) {
  const trpc = useTRPC()
  const can = useCan()
  const queryClient = useQueryClient()
  const c = d.contract
  const status = c.status ?? 'draft'
  const editable = status === 'draft' && can('contracts', 'edit')
  const [overrides, setOverrides] = useState<Record<string, string>>(() => ({ ...(c.overrides ?? {}) }))
  const [sentTo, setSentTo] = useState('')
  const [sentOn, setSentOn] = useState(today())
  const [signedOn, setSignedOn] = useState(today())

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: trpc.contracts.get.queryKey({ id: c.id }) })
    await queryClient.invalidateQueries({
      queryKey: trpc.contracts.forEngagement.queryKey({ engagementId: d.engagement.id }),
    })
    await queryClient.invalidateQueries({ queryKey: trpc.engagements.get.queryKey({ id: d.engagement.id }) })
  }
  const save = useMutation(trpc.contracts.setOverrides.mutationOptions({ onSuccess: refresh }))
  const download = useMutation(trpc.contracts.download.mutationOptions())
  const markSent = useMutation(trpc.contracts.markSent.mutationOptions({ onSuccess: refresh }))
  const markSigned = useMutation(trpc.contracts.markSigned.mutationOptions({ onSuccess: refresh }))
  const voidIt = useMutation(trpc.contracts.void.mutationOptions({ onSuccess: refresh }))
  const error = save.error ?? download.error ?? markSent.error ?? markSigned.error ?? voidIt.error

  const dirty = JSON.stringify(overrides) !== JSON.stringify(c.overrides ?? {})
  const setOverride = (name: string, value: string | null) =>
    setOverrides((o) => {
      const next = { ...o }
      if (value === null) delete next[name]
      else next[name] = value
      return next
    })

  return (
    <section>
      <p className="crumbs">
        <Link to={`/productions/${d.production.id}/contracts`}>{d.production.title} contracts</Link> ·{' '}
        <Link to={`/engagements/${d.engagement.id}`}>
          {displayName(d.person)} as {d.engagement.role}
        </Link>
      </p>
      <div className="title-row">
        <h1>{c.template.name}</h1>
        <StatusChip status={status} />
      </div>
      <p className="muted">
        {TEMPLATE_FORMAT_LABELS[c.template.format]}, version {c.template.version}
        {c.sentOn ? ` · Sent ${formatDate(c.sentOn)} to ${c.sentTo}` : ''}
        {c.signedOn ? ` · Signed ${formatDate(c.signedOn)}` : ''}
      </p>

      {status === 'draft' ? (
        d.blanks.length ? (
          <p className="error">
            {d.blanks.length} required {d.blanks.length === 1 ? 'field is' : 'fields are'} blank: {d.blanks.join(', ')}.
            Fill them on the production, the person or the deal, or type a value below.
          </p>
        ) : (
          <p className="ok">Every required field is filled.</p>
        )
      ) : null}

      <div className="actions">
        <button
          type="button"
          className="secondary"
          disabled={download.isPending || dirty}
          title={dirty ? 'Save your changes first' : undefined}
          onClick={async () => {
            const file = await download.mutateAsync({ id: c.id })
            saveFile(file.fileName, file.base64)
          }}
        >
          {download.isPending ? 'Making PDF…' : 'Download PDF'}
        </button>
        {status !== 'void' && status !== 'signed' && can('contracts', 'edit') ? (
          <button
            type="button"
            className="link danger"
            disabled={voidIt.isPending}
            onClick={() => {
              if (confirm('Void this contract? You can prepare a new one afterwards.')) voidIt.mutate({ id: c.id })
            }}
          >
            Void
          </button>
        ) : null}
      </div>
      <p className="muted small">The PDF holds the person’s home address and pay. Every download is logged.</p>

      {editable ? (
        <form
          className="card wide"
          onSubmit={(e: FormEvent) => {
            e.preventDefault()
            markSent.mutate({ id: c.id, sentOn, sentTo })
          }}
        >
          <h2>Mark sent</h2>
          <p className="muted small">
            Send the PDF yourself, then record it here. The app doesn’t email contracts yet. This moves{' '}
            {displayName(d.person)} to {PIPELINE_LABELS.contract_sent}.
          </p>
          <div className="grid">
            <label>
              Sent to
              <input
                value={sentTo}
                onChange={(e) => setSentTo(e.target.value)}
                placeholder="e.g. them and their agent"
                required
              />
            </label>
            <label>
              Sent on
              <input type="date" value={sentOn} onChange={(e) => setSentOn(e.target.value)} required />
            </label>
          </div>
          <div className="actions">
            <button type="submit" disabled={markSent.isPending || dirty || d.blanks.length > 0}>
              {markSent.isPending ? 'Saving…' : 'Mark sent'}
            </button>
          </div>
        </form>
      ) : null}

      {status === 'sent' && can('contracts', 'edit') ? (
        <form
          className="card wide"
          onSubmit={(e: FormEvent) => {
            e.preventDefault()
            markSigned.mutate({ id: c.id, signedOn })
          }}
        >
          <h2>Mark signed</h2>
          <p className="muted small">
            When the signed copy comes back. Once every contract for this deal is signed, it moves to{' '}
            {PIPELINE_LABELS.contract_signed}.
          </p>
          <div className="grid">
            <label>
              Signed on
              <input type="date" value={signedOn} onChange={(e) => setSignedOn(e.target.value)} required />
            </label>
          </div>
          <div className="actions">
            <button type="submit" disabled={markSigned.isPending}>
              {markSigned.isPending ? 'Saving…' : 'Mark signed'}
            </button>
          </div>
        </form>
      ) : null}

      <section className="card wide">
        <h2>What goes on it</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Field</th>
                <th>Value</th>
                {editable ? <th>Type over it</th> : null}
              </tr>
            </thead>
            <tbody>
              {d.fields.map((f) => (
                <tr key={f.name} className={f.blank ? 'blank' : undefined}>
                  <td>
                    {f.label}
                    {f.required ? '' : <span className="muted small"> (optional)</span>}
                  </td>
                  <td>
                    {f.personal ? (
                      <span className="muted">{f.filled ? 'On file (from their profile)' : 'Not on file'}</span>
                    ) : f.value ? (
                      f.value
                    ) : (
                      <span className="muted">{f.blank ? 'Blank' : '–'}</span>
                    )}
                    {f.overridden ? <span className="muted small"> (typed)</span> : null}
                  </td>
                  {editable ? (
                    <td>
                      {f.personal ? (
                        <Link className="small" to={`/people/${d.person.id}`}>
                          Edit on profile
                        </Link>
                      ) : f.computed ? (
                        <span className="muted small">From the venue numbers</span>
                      ) : f.kind === 'choice' ? (
                        <select
                          value={overrides[f.name] ?? ''}
                          onChange={(e) => setOverride(f.name, e.target.value || null)}
                          aria-label={f.label}
                        >
                          <option value="">As filled</option>
                          {f.options?.map((o) => (
                            <option key={o} value={o}>
                              {o}
                            </option>
                          ))}
                        </select>
                      ) : f.kind === 'checkbox' ? (
                        <select
                          value={overrides[f.name] === undefined ? 'auto' : overrides[f.name] ? 'yes' : 'no'}
                          onChange={(e) =>
                            setOverride(
                              f.name,
                              e.target.value === 'auto' ? null : e.target.value === 'yes' ? 'yes' : '',
                            )
                          }
                          aria-label={f.label}
                        >
                          <option value="auto">As filled</option>
                          <option value="yes">Checked</option>
                          <option value="no">Unchecked</option>
                        </select>
                      ) : (
                        <input
                          value={overrides[f.name] ?? ''}
                          placeholder="As filled"
                          aria-label={f.label}
                          onChange={(e) => setOverride(f.name, e.target.value === '' ? null : e.target.value)}
                        />
                      )}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {editable ? (
          <div className="actions">
            <button
              type="button"
              disabled={!dirty || save.isPending}
              onClick={() => save.mutate({ id: c.id, overrides })}
            >
              {save.isPending ? 'Saving…' : 'Save changes'}
            </button>
            {dirty ? (
              <button type="button" className="secondary" onClick={() => setOverrides({ ...(c.overrides ?? {}) })}>
                Undo
              </button>
            ) : null}
          </div>
        ) : null}
      </section>
      {error ? <p className="error">{errorText(error)}</p> : null}
    </section>
  )
}

// ---------------------------------------------------------------------------
// A production's contracts
// ---------------------------------------------------------------------------

export function ProductionContractsPage() {
  const { productionId = '' } = useParams()
  const trpc = useTRPC()
  const data = useQuery(trpc.contracts.byProduction.queryOptions({ productionId }))
  if (data.isPending) return <p className="muted">Loading…</p>
  if (data.error) return <p className="error">{errorText(data.error)}</p>
  const d = data.data
  const all = d.engagements.flatMap((e) => e.contracts)
  const count = (s: ContractStatus) => all.filter((c) => c.status === s).length
  const missing = d.engagements.filter((e) => e.contractType !== 'non_union' && !e.contracts.length).length

  return (
    <section>
      <p className="crumbs">
        <Link to="/seasons">Seasons</Link>
      </p>
      <h1>{d.production.title}: contracts</h1>
      <ul className="chips">
        <li className="chip">Not prepared: {missing}</li>
        <li className="chip contract-draft">Draft: {count('draft')}</li>
        <li className="chip contract-sent">Sent: {count('sent')}</li>
        <li className="chip contract-signed">Signed: {count('signed')}</li>
      </ul>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Contract type</th>
              <th>Contracts</th>
            </tr>
          </thead>
          <tbody>
            {d.engagements.map((e) => (
              <tr key={e.id}>
                <td>
                  <Link to={`/engagements/${e.id}`}>{displayName(e)}</Link>
                </td>
                <td>{e.role}</td>
                <td>{CONTRACT_TYPE_LABELS[e.contractType]}</td>
                <td>
                  {e.contracts.length ? (
                    e.contracts.map((c) => (
                      <span key={c.id} className="nowrap">
                        <Link to={`/contracts/${c.id}`}>{c.template.name}</Link>{' '}
                        {c.status ? <StatusChip status={c.status} /> : null}{' '}
                      </span>
                    ))
                  ) : (
                    <span className="muted">{e.contractType === 'non_union' ? 'None needed yet' : 'Not prepared'}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Settings: the theatre's details and the templates
// ---------------------------------------------------------------------------

export function ContractSettingsPage() {
  const can = useCan()
  if (!can('contracts')) return <p className="error">Your role has no access to contracts.</p>
  return (
    <section>
      <h1>Contract settings</h1>
      <OrganizationForm />
      <Templates />
    </section>
  )
}

const ORG_KEYS = Object.keys(ORGANIZATION_LABELS) as (keyof OrganizationValues)[]

function OrganizationForm() {
  const trpc = useTRPC()
  const can = useCan()
  const queryClient = useQueryClient()
  const org = useQuery(trpc.contracts.organization.get.queryOptions())
  const save = useMutation(trpc.contracts.organization.save.mutationOptions())
  const [draft, setDraft] = useState<Record<string, string> | null>(null)
  if (org.isPending) return <p className="muted">Loading…</p>
  if (org.error) return <p className="error">{errorText(org.error)}</p>
  const values = draft ?? Object.fromEntries(ORG_KEYS.map((k) => [k, org.data[k] ?? '']))
  const editable = can('contracts', 'edit')

  return (
    <form
      className="card wide"
      onSubmit={async (e) => {
        e.preventDefault()
        await save.mutateAsync(Object.fromEntries(ORG_KEYS.map((k) => [k, values[k]?.trim() || null])))
        setDraft(null)
        await queryClient.invalidateQueries({ queryKey: trpc.contracts.organization.get.queryKey() })
      }}
    >
      <h2>The theatre</h2>
      <p className="muted small">Printed on every contract as the employer.</p>
      <fieldset className="grid" disabled={!editable}>
        {ORG_KEYS.map((k) => (
          <label key={k}>
            {ORGANIZATION_LABELS[k]}
            <input value={values[k] ?? ''} onChange={(e) => setDraft({ ...values, [k]: e.target.value })} />
          </label>
        ))}
      </fieldset>
      {editable ? (
        <div className="actions">
          <button type="submit" disabled={!draft || save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          {save.isSuccess && !draft ? <span className="muted">Saved.</span> : null}
        </div>
      ) : null}
      {save.error ? <p className="error">{errorText(save.error)}</p> : null}
    </form>
  )
}

type TemplateRow = Outputs['contracts']['templates']['list'][number]

function Templates() {
  const trpc = useTRPC()
  const can = useCan()
  const list = useQuery(trpc.contracts.templates.list.queryOptions())
  const [editing, setEditing] = useState<TemplateRow | 'new-text' | 'new-form' | null>(null)
  const editable = can('contracts', 'edit')
  if (list.isPending) return <p className="muted">Loading…</p>
  if (list.error) return <p className="error">{errorText(list.error)}</p>
  const active = list.data.filter((t) => t.active)
  const retired = list.data.filter((t) => !t.active)

  return (
    <section className="card wide">
      <h2>Templates</h2>
      <p className="muted small">
        Upload the unions’ blank fillable forms as they come: the app fills their fields and changes nothing else. The
        theatre’s rider is a text template.
      </p>
      <TemplateTable rows={active} onEdit={editable ? setEditing : undefined} />
      {editable && !editing ? (
        <div className="actions">
          <button type="button" onClick={() => setEditing('new-form')}>
            Upload a union form
          </button>
          <button type="button" className="secondary" onClick={() => setEditing('new-text')}>
            New text template
          </button>
        </div>
      ) : null}
      {editing === 'new-form' || (editing && editing !== 'new-text' && editing.format !== 'text') ? (
        <UploadForm replaces={typeof editing === 'object' ? editing : undefined} onDone={() => setEditing(null)} />
      ) : null}
      {editing === 'new-text' || (editing && typeof editing === 'object' && editing.format === 'text') ? (
        <TextTemplateForm
          replaces={typeof editing === 'object' ? editing : undefined}
          onDone={() => setEditing(null)}
        />
      ) : null}
      {retired.length ? (
        <details>
          <summary>Retired versions ({retired.length})</summary>
          <TemplateTable rows={retired} />
        </details>
      ) : null}
    </section>
  )
}

function TemplateTable({ rows, onEdit }: { rows: TemplateRow[]; onEdit?: (t: TemplateRow) => void }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const retire = useMutation(
    trpc.contracts.templates.retire.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.contracts.templates.list.queryKey() }),
    }),
  )
  if (!rows.length) return <p className="muted">None yet.</p>
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Kind</th>
            <th>For</th>
            <th>Version</th>
            {onEdit ? <th /> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.id}>
              <td>
                {t.name}
                {t.fileName ? <span className="muted small"> ({t.fileName})</span> : null}
              </td>
              <td>{t.format ? TEMPLATE_FORMAT_LABELS[t.format] : ''}</td>
              <td>{t.contractType ? CONTRACT_TYPE_LABELS[t.contractType] : ''}</td>
              <td>{t.version}</td>
              {onEdit ? (
                <td className="nowrap">
                  <button type="button" className="link" onClick={() => onEdit(t)}>
                    {t.format === 'text' ? 'Edit' : 'Replace'}
                  </button>{' '}
                  <button
                    type="button"
                    className="link danger"
                    onClick={() => {
                      if (confirm(`Retire ${t.name}? Contracts already made from it keep it.`))
                        retire.mutate({ id: t.id })
                    }}
                  >
                    Retire
                  </button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {retire.error ? <p className="error">{errorText(retire.error)}</p> : null}
    </div>
  )
}

function UploadForm({ replaces, onDone }: { replaces?: TemplateRow; onDone: () => void }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const upload = useMutation(trpc.contracts.templates.uploadForm.mutationOptions())
  const [name, setName] = useState(replaces?.name ?? '')
  const [file, setFile] = useState<File | null>(null)
  const [readError, setReadError] = useState<string | null>(null)

  return (
    <form
      className="card"
      onSubmit={async (e) => {
        e.preventDefault()
        if (!file) return
        if (file.size > 3_000_000) {
          setReadError('That file is over 3 MB. The unions’ forms are well under that.')
          return
        }
        const buffer = new Uint8Array(await file.arrayBuffer())
        let binary = ''
        for (let i = 0; i < buffer.length; i += 0x8000) binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000))
        await upload.mutateAsync({ name, fileName: file.name, pdfBase64: btoa(binary), replacesId: replaces?.id })
        await queryClient.invalidateQueries({ queryKey: trpc.contracts.templates.list.queryKey() })
        onDone()
      }}
    >
      <h3>{replaces ? `New version of ${replaces.name}` : 'Upload a union form'}</h3>
      <p className="muted small">
        The blank fillable PDF from Equity or SDC. Don’t upload a filled or signed contract: the template is shared by
        everyone’s contracts.
      </p>
      <div className="grid">
        <label>
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. SDC tier agreement 2026-27"
            required
          />
        </label>
        <label>
          Blank form (PDF)
          <input type="file" accept="application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />
        </label>
      </div>
      <div className="actions">
        <button type="submit" disabled={!file || upload.isPending}>
          {upload.isPending ? 'Checking the form…' : 'Upload'}
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          Cancel
        </button>
      </div>
      {readError ? <p className="error">{readError}</p> : null}
      {upload.error ? <p className="error">{errorText(upload.error)}</p> : null}
    </form>
  )
}

function TextTemplateForm({ replaces, onDone }: { replaces?: TemplateRow; onDone: () => void }) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const save = useMutation(trpc.contracts.templates.saveText.mutationOptions())
  const [name, setName] = useState(replaces?.name ?? 'Theatre Raleigh ITC rider')
  const [contractType, setContractType] = useState<ContractType>(replaces?.contractType ?? 'equity_itc')
  const [body, setBody] = useState(replaces?.body ?? DEFAULT_RIDER_BODY)

  return (
    <form
      className="card wide"
      onSubmit={async (e) => {
        e.preventDefault()
        await save.mutateAsync({ name, contractType, body, replacesId: replaces?.id })
        await queryClient.invalidateQueries({ queryKey: trpc.contracts.templates.list.queryKey() })
        onDone()
      }}
    >
      <h3>{replaces ? `Edit ${replaces.name} (saves version ${(replaces.version ?? 1) + 1})` : 'New text template'}</h3>
      <div className="grid">
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label>
          For contract type
          <select value={contractType} onChange={(e) => setContractType(e.target.value as ContractType)}>
            {CONTRACT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="span-all">
          Text
          <textarea rows={18} value={body} onChange={(e) => setBody(e.target.value)} required />
        </label>
      </div>
      <p className="muted small">
        A line starting with # is a heading. These fill in from the deal:{' '}
        {Object.entries(TEXT_TOKENS)
          .map(([k, t]) => `{{${k}}} ${t.label.toLowerCase()}`)
          .join(' · ')}
      </p>
      <div className="actions">
        <button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save template'}
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          Cancel
        </button>
      </div>
      {save.error ? <p className="error">{errorText(save.error)}</p> : null}
    </form>
  )
}
