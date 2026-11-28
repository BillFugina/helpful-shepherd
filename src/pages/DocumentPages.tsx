import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { ADMIN_ROLE } from '../../shared/access'
import {
  ACCEPT_ATTRIBUTE,
  DOCUMENT_STATUS_LABELS,
  DOCUMENT_TYPE_LABELS,
  DOCUMENT_TYPES,
  formsToRemind,
  MAX_FILE_BYTES,
  OPEN_FOR_UPLOAD,
  type ChecklistItem,
  type ChecklistSummary,
  type DocumentType,
} from '../../shared/documents'
import { CONTRACT_TYPE_LABELS, CONTRACT_TYPES, PIPELINE_LABELS, type ContractType } from '../../shared/roster'
import { errorText } from '../lib/errors'
import { displayName, formatDate, useCan } from '../lib/fields'
import { useTRPC } from '../lib/trpc'
import { useMe } from '../lib/useMe'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function saveFile(fileName: string, mime: string, base64: string) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

async function fileToBase64(file: File): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let i = 0; i < buffer.length; i += 0x8000) binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000))
  return btoa(binary)
}

const TOO_BIG = 'That file is over 3 MB. Try a smaller scan, or a photo instead of a scan.'

function StatusChip({ item }: { item: Pick<ChecklistItem, 'status' | 'financeNote'> }) {
  const flagged = item.status === 'received' && item.financeNote
  return (
    <span className={`chip doc-${flagged ? 'flagged' : item.status}`}>
      {flagged ? 'Sent back by Finance' : DOCUMENT_STATUS_LABELS[item.status]}
    </span>
  )
}

function SummaryLine({ s }: { s: ChecklistSummary }) {
  if (!s.total) return <span className="muted">No forms needed</span>
  if (s.complete) return <span className="chip doc-accepted">All {s.total} done</span>
  const parts = [
    s.missing ? `${s.missing} missing` : null,
    s.received ? `${s.received} to send` : null,
    s.withFinance ? `${s.withFinance} with Finance` : null,
  ].filter(Boolean)
  return (
    <span>
      {s.done} of {s.total} done{parts.length ? ` · ${parts.join(' · ')}` : ''}
      {s.flagged ? <span className="chip doc-flagged"> {s.flagged} sent back</span> : null}
    </span>
  )
}

// ---------------------------------------------------------------------------
// On the engagement page
// ---------------------------------------------------------------------------

/** The engagement's paperwork: each form's status, the actions on it, and upload links. */
export function EngagementDocuments({ engagementId }: { engagementId: string }) {
  const trpc = useTRPC()
  const can = useCan()
  const queryClient = useQueryClient()
  const data = useQuery({ ...trpc.documents.forEngagement.queryOptions({ engagementId }), enabled: can('documents') })
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.documents.forEngagement.queryKey({ engagementId }) }),
      queryClient.invalidateQueries({ queryKey: trpc.documents.financeQueue.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.engagements.get.queryKey({ id: engagementId }) }),
    ])
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState<DocumentType | null>(null)
  const download = useMutation(trpc.documents.download.mutationOptions())
  const upload = useMutation(trpc.documents.upload.mutationOptions({ onSuccess: refresh }))
  const removeFile = useMutation(trpc.documents.removeFile.mutationOptions({ onSuccess: refresh }))
  const send = useMutation(trpc.documents.sendToFinance.mutationOptions({ onSuccess: refresh }))
  const accept = useMutation(trpc.documents.accept.mutationOptions({ onSuccess: refresh }))
  const flag = useMutation(trpc.documents.flag.mutationOptions({ onSuccess: refresh }))
  const notNeeded = useMutation(trpc.documents.markNotNeeded.mutationOptions({ onSuccess: refresh }))
  const reopen = useMutation(trpc.documents.reopen.mutationOptions({ onSuccess: refresh }))
  if (!can('documents')) return null

  const edit = can('documents', 'edit')
  const files = can('tax_bank', 'edit')
  const finance = can('documents', 'review') && can('tax_bank', 'review')
  const busy = [download, upload, removeFile, send, accept, flag, notNeeded, reopen].some((m) => m.isPending)
  const run = async (fn: () => Promise<unknown>) => {
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <section className="card wide">
      <h2>Documents</h2>
      {data.isPending ? <p className="muted">Loading…</p> : null}
      {data.error ? <p className="error">{errorText(data.error)}</p> : null}
      {data.data ? (
        <>
          <p>
            <SummaryLine s={data.data.summary} />
          </p>
          {data.data.checklist.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Form</th>
                    <th>Status</th>
                    <th>Dates</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.data.checklist.map((item) => {
                    const ref = { engagementId, documentType: item.documentType }
                    const canOpen =
                      data.data.canSeeFiles &&
                      (item.hasFile || item.status === 'received' || item.status === 'sent_to_finance')
                    return (
                      <tr key={item.documentType}>
                        <td>
                          {DOCUMENT_TYPE_LABELS[item.documentType]}
                          {!item.required ? <span className="muted small"> (not on the list)</span> : null}
                        </td>
                        <td>
                          <StatusChip item={item} />
                          {item.financeNote && item.status === 'received' ? (
                            <div className="small">Finance: {item.financeNote}</div>
                          ) : null}
                        </td>
                        <td className="small muted">
                          {item.receivedOn ? <div>Received {formatDate(item.receivedOn)}</div> : null}
                          {item.sentToFinanceAt ? <div>Sent {item.sentToFinanceAt.toLocaleDateString()}</div> : null}
                          {item.acceptedAt ? <div>Accepted {item.acceptedAt.toLocaleDateString()}</div> : null}
                          {item.filePurgedAt && !item.hasFile ? <div>File deleted</div> : null}
                        </td>
                        <td className="actions-cell">
                          {canOpen ? (
                            <button
                              type="button"
                              className="link"
                              disabled={busy}
                              onClick={() =>
                                void run(async () => {
                                  const f = await download.mutateAsync(ref)
                                  saveFile(f.fileName, f.mime, f.base64)
                                })
                              }
                            >
                              Open
                            </button>
                          ) : null}
                          {edit && files && OPEN_FOR_UPLOAD.has(item.status) ? (
                            uploading === item.documentType ? (
                              <input
                                type="file"
                                accept={ACCEPT_ATTRIBUTE}
                                disabled={busy}
                                onChange={(e) => {
                                  const file = e.target.files?.[0]
                                  if (!file) return
                                  if (file.size > MAX_FILE_BYTES) {
                                    setError(TOO_BIG)
                                    return
                                  }
                                  void run(async () => {
                                    await upload.mutateAsync({
                                      ...ref,
                                      fileName: file.name,
                                      base64: await fileToBase64(file),
                                    })
                                    setUploading(null)
                                  })
                                }}
                              />
                            ) : (
                              <button
                                type="button"
                                className="link"
                                disabled={busy}
                                onClick={() => setUploading(item.documentType)}
                              >
                                {item.hasFile ? 'Replace' : 'Upload'}
                              </button>
                            )
                          ) : null}
                          {edit && item.status === 'received' ? (
                            <button
                              type="button"
                              className="link"
                              disabled={busy}
                              onClick={() => void run(() => send.mutateAsync(ref))}
                            >
                              Send to Finance
                            </button>
                          ) : null}
                          {edit && files && item.status === 'received' && item.hasFile ? (
                            <button
                              type="button"
                              className="link"
                              disabled={busy}
                              onClick={() => {
                                if (window.confirm('Delete this file? The form goes back to Missing.')) {
                                  void run(() => removeFile.mutateAsync(ref))
                                }
                              }}
                            >
                              Remove file
                            </button>
                          ) : null}
                          {finance && item.status === 'sent_to_finance' ? (
                            <FinanceButtons
                              busy={busy}
                              onAccept={() =>
                                void run(async () => {
                                  if (
                                    window.confirm(
                                      'Accept this form? The app deletes its copy now and keeps only the status.',
                                    )
                                  ) {
                                    await accept.mutateAsync(ref)
                                  }
                                })
                              }
                              onFlag={(note) => void run(() => flag.mutateAsync({ ...ref, note }))}
                            />
                          ) : null}
                          {edit && OPEN_FOR_UPLOAD.has(item.status) && (files || !item.hasFile) ? (
                            <button
                              type="button"
                              className="link"
                              disabled={busy}
                              onClick={() => void run(() => notNeeded.mutateAsync(ref))}
                            >
                              Not needed
                            </button>
                          ) : null}
                          {edit && (item.status === 'not_needed' || item.status === 'accepted') ? (
                            <button
                              type="button"
                              className="link"
                              disabled={busy}
                              onClick={() => void run(() => reopen.mutateAsync(ref))}
                            >
                              Reopen
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">
              No forms are on the list for this contract type. <Link to="/documents/settings">Document settings</Link>
            </p>
          )}
          {error ? <p className="error">{error}</p> : null}
          {edit ? (
            <UploadLinks
              engagementId={engagementId}
              checklist={data.data.checklist}
              links={data.data.links}
              onChange={refresh}
            />
          ) : null}
          {formsToRemind(data.data.checklist).length ? (
            <EngagementReminder engagementId={engagementId} onChange={refresh} />
          ) : null}
        </>
      ) : null}
    </section>
  )
}

function EngagementReminder({ engagementId, onChange }: { engagementId: string; onChange: () => Promise<unknown> }) {
  const reminders = useReminders(onChange)
  const [results, setResults] = useState<ReminderResultRow[] | null>(null)
  if (!reminders.allowed) return null
  return (
    <div className="subsection">
      <h3>Reminder</h3>
      <p className="muted small">
        Emails them the forms they still owe, with a fresh upload link.
        {reminders.mode ? ` ${REMINDER_MODE_TEXT[reminders.mode]}` : ''}
      </p>
      <RemindButton
        engagementIds={[engagementId]}
        label="Email a reminder"
        reminders={reminders}
        onResults={setResults}
      />
      {results ? <ReminderResults results={results} onClose={() => setResults(null)} /> : null}
    </div>
  )
}

function FinanceButtons({
  busy,
  onAccept,
  onFlag,
}: {
  busy: boolean
  onAccept: () => void
  onFlag: (note: string) => void
}) {
  const [note, setNote] = useState<string | null>(null)
  if (note !== null) {
    return (
      <span className="inline-form">
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What needs fixing" maxLength={500} />
        <button type="button" className="secondary" disabled={busy || !note.trim()} onClick={() => onFlag(note.trim())}>
          Send back
        </button>
        <button type="button" className="link" onClick={() => setNote(null)}>
          Cancel
        </button>
      </span>
    )
  }
  return (
    <>
      <button type="button" className="link" disabled={busy} onClick={onAccept}>
        Accept
      </button>
      <button type="button" className="link" disabled={busy} onClick={() => setNote('')}>
        Send back
      </button>
    </>
  )
}

type LinkRow = {
  id: string
  documentTypes: DocumentType[]
  expiresAt: Date
  uploads: number
  state: 'open' | 'expired' | 'revoked' | 'used_up'
}

const LINK_STATE_LABELS: Record<LinkRow['state'], string> = {
  open: 'Open',
  expired: 'Expired',
  revoked: 'Turned off',
  used_up: 'Used up',
}

function UploadLinks({
  engagementId,
  checklist,
  links,
  onChange,
}: {
  engagementId: string
  checklist: ChecklistItem[]
  links: LinkRow[]
  onChange: () => Promise<unknown>
}) {
  const trpc = useTRPC()
  const create = useMutation(trpc.documents.links.create.mutationOptions({ onSuccess: onChange }))
  const revoke = useMutation(trpc.documents.links.revoke.mutationOptions({ onSuccess: onChange }))
  const open = checklist.filter((i) => i.required && OPEN_FOR_UPLOAD.has(i.status)).map((i) => i.documentType)
  const [made, setMade] = useState<{ url: string; expiresAt: Date } | null>(null)
  const [copied, setCopied] = useState(false)

  return (
    <div className="subsection">
      <h3>Upload link</h3>
      <p className="muted small">
        A private link you send so they can upload their own forms, no account needed. It works for the forms still
        open, until it expires.
      </p>
      {made ? (
        <div className="banner">
          <p>Copy this link now. It won’t be shown again. It works until {made.expiresAt.toLocaleDateString()}.</p>
          <p>
            <code className="break">{made.url}</code>{' '}
            <button
              type="button"
              className="secondary"
              onClick={() => {
                void navigator.clipboard.writeText(made.url).then(() => setCopied(true))
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </p>
        </div>
      ) : null}
      {open.length ? (
        <button
          type="button"
          disabled={create.isPending}
          onClick={async () => {
            setCopied(false)
            setMade(await create.mutateAsync({ engagementId, documentTypes: open }))
          }}
        >
          {create.isPending ? 'Making…' : `Make a link for ${open.length} open form${open.length === 1 ? '' : 's'}`}
        </button>
      ) : (
        <p className="muted small">Every form is in. No link needed.</p>
      )}
      {links.length ? (
        <ul className="plain small">
          {links.map((l) => (
            <li key={l.id}>
              {LINK_STATE_LABELS[l.state]}: {l.documentTypes.map((t) => DOCUMENT_TYPE_LABELS[t]).join(', ')}
              {l.state === 'open' ? ` · until ${l.expiresAt.toLocaleDateString()}` : ''} · {l.uploads} upload
              {l.uploads === 1 ? '' : 's'}
              {l.state === 'open' ? (
                <>
                  {' '}
                  <button
                    type="button"
                    className="link"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate({ id: l.id })}
                  >
                    Turn off
                  </button>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {(create.error ?? revoke.error) ? <p className="error">{errorText(create.error ?? revoke.error)}</p> : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

type ReminderMode = 'log' | 'allowlist' | 'live'

interface ReminderResultRow {
  engagementId: string
  name: string
  outcome: 'sent' | 'logged' | 'held' | 'skipped' | 'failed'
  reason?: string
  email?: { to: string; subject: string; text: string }
}

const REMINDER_MODE_TEXT: Record<ReminderMode, string> = {
  log: 'Reminders aren’t emailed from here. Each one makes a fresh upload link and shows you the email to send yourself.',
  allowlist: 'Test mode: reminders are emailed only to addresses on the test list.',
  live: 'Reminders are emailed for real. Demo people never get one.',
}

const OUTCOME_LABELS: Record<ReminderResultRow['outcome'], string> = {
  sent: 'Emailed',
  logged: 'Ready for you to send',
  held: 'Not emailed',
  skipped: 'Skipped',
  failed: 'Didn’t send',
}

function useReminders(onDone: () => Promise<unknown>) {
  const trpc = useTRPC()
  const can = useCan()
  const allowed = can('documents', 'edit') && can('contact')
  const status = useQuery({ ...trpc.documents.reminders.status.queryOptions(), enabled: allowed })
  const send = useMutation(trpc.documents.reminders.send.mutationOptions({ onSuccess: onDone }))
  return { allowed, mode: status.data?.mode ?? null, send }
}

function EmailPreview({ email }: { email: NonNullable<ReminderResultRow['email']> }) {
  const [copied, setCopied] = useState(false)
  return (
    <details>
      <summary>See the email</summary>
      <p className="small">
        To: {email.to}
        <br />
        Subject: {email.subject}
      </p>
      <pre className="email-preview">{email.text}</pre>
      <button
        type="button"
        className="secondary"
        onClick={() => {
          void navigator.clipboard.writeText(email.text).then(() => setCopied(true))
        }}
      >
        {copied ? 'Copied' : 'Copy the email'}
      </button>
    </details>
  )
}

function ReminderResults({ results, onClose }: { results: ReminderResultRow[]; onClose: () => void }) {
  return (
    <div className="banner">
      <ul className="plain">
        {results.map((r) => (
          <li key={r.engagementId}>
            <strong>{r.name || 'Unknown'}</strong>: {OUTCOME_LABELS[r.outcome]}
            {r.reason ? <span className="muted small"> · {r.reason}</span> : null}
            {r.email ? <EmailPreview email={r.email} /> : null}
          </li>
        ))}
      </ul>
      <p className="muted small">
        Links in emails that weren’t sent still work until they expire. Copy them now: they won’t be shown again.
      </p>
      <button type="button" className="link" onClick={onClose}>
        Close
      </button>
    </div>
  )
}

function RemindButton({
  engagementIds,
  label,
  reminders,
  onResults,
}: {
  engagementIds: string[]
  label: string
  reminders: ReturnType<typeof useReminders>
  onResults: (r: ReminderResultRow[]) => void
}) {
  const [error, setError] = useState<string | null>(null)
  return (
    <>
      <button
        type="button"
        className="secondary"
        disabled={reminders.send.isPending || !engagementIds.length}
        onClick={async () => {
          setError(null)
          try {
            const out = await reminders.send.mutateAsync({ engagementIds })
            onResults(out.results)
          } catch (e) {
            setError(errorText(e))
          }
        }}
      >
        {reminders.send.isPending ? 'Sending…' : label}
      </button>
      {error ? <span className="error small"> {error}</span> : null}
    </>
  )
}

// ---------------------------------------------------------------------------
// A production's paperwork
// ---------------------------------------------------------------------------

export function ProductionDocumentsPage() {
  const { productionId = '' } = useParams()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const data = useQuery(trpc.documents.overview.queryOptions({ productionId }))
  const reminders = useReminders(() =>
    queryClient.invalidateQueries({ queryKey: trpc.documents.overview.queryKey({ productionId }) }),
  )
  const [results, setResults] = useState<ReminderResultRow[] | null>(null)
  if (data.isPending) return <p className="muted">Loading…</p>
  if (data.error) return <p className="error">{errorText(data.error)}</p>
  const d = data.data
  const outstanding = d.engagements.filter((e) => !e.summary.complete)
  const done = d.engagements.length - outstanding.length
  const remindable = d.engagements.filter((e) => e.toRemind.length && e.hasEmail).map((e) => e.id)

  return (
    <section>
      <p className="crumbs">
        <Link to="/seasons">Seasons</Link> · <Link to="/documents">Documents</Link>
      </p>
      <h1>{d.production.title}: documents</h1>
      <ul className="chips">
        <li className="chip doc-accepted">Complete: {done}</li>
        <li className="chip doc-missing">Still collecting: {outstanding.length}</li>
      </ul>
      {reminders.allowed ? (
        <div className="subsection">
          {reminders.mode ? <p className="muted small">{REMINDER_MODE_TEXT[reminders.mode]}</p> : null}
          <RemindButton
            engagementIds={remindable}
            label={
              remindable.length
                ? `Remind ${remindable.length} ${remindable.length === 1 ? 'person' : 'people'} with missing forms`
                : 'No one to remind'
            }
            reminders={reminders}
            onResults={setResults}
          />
          {results ? <ReminderResults results={results} onClose={() => setResults(null)} /> : null}
        </div>
      ) : null}
      <div className="table-wrap" data-tour="documents-checklist">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Contract</th>
              <th>Stage</th>
              <th>Forms</th>
              <th>Still open</th>
              {reminders.allowed ? <th>Reminder</th> : null}
            </tr>
          </thead>
          <tbody>
            {d.engagements.map((e) => (
              <tr key={e.id}>
                <td>
                  <Link to={`/engagements/${e.id}`}>{displayName(e)}</Link>
                  <div className="muted small">{e.role}</div>
                </td>
                <td>{CONTRACT_TYPE_LABELS[e.contractType]}</td>
                <td>
                  <span className={`chip status-${e.pipelineStatus}`}>{PIPELINE_LABELS[e.pipelineStatus]}</span>
                </td>
                <td>
                  <SummaryLine s={e.summary} />
                </td>
                <td className="small">
                  {e.checklist
                    .filter((i) => i.required && i.status !== 'accepted' && i.status !== 'not_needed')
                    .map((i) => (
                      <div key={i.documentType}>
                        {DOCUMENT_TYPE_LABELS[i.documentType]}: <StatusChip item={i} />
                      </div>
                    ))}
                </td>
                {reminders.allowed ? (
                  <td className="small">
                    {e.toRemind.length ? (
                      e.hasEmail ? (
                        <RemindButton
                          engagementIds={[e.id]}
                          label="Remind"
                          reminders={reminders}
                          onResults={setResults}
                        />
                      ) : (
                        <span className="muted">No email on file</span>
                      )
                    ) : null}
                    {e.lastReminder ? (
                      <div className="muted">
                        Last: {new Date(e.lastReminder.at).toLocaleDateString()}
                        {e.lastReminder.delivery === 'sent' ? '' : ' (not emailed)'}
                      </div>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        Forms are deleted from the app as soon as Finance accepts them. Any still held {d.retentionYears} years after a
        production closes are deleted automatically
        {d.retentionConfirmed ? '.' : ' (a starting guess, waiting for Finance to confirm).'}
      </p>
    </section>
  )
}

// ---------------------------------------------------------------------------
// The Documents page: Finance's queue and where to go next
// ---------------------------------------------------------------------------

export function DocumentsPage() {
  const trpc = useTRPC()
  const can = useCan()
  const queue = useQuery({ ...trpc.documents.financeQueue.queryOptions(), enabled: can('documents') })
  const seasons = useQuery(trpc.seasons.list.queryOptions())
  if (!can('documents')) return <p className="error">Your role has no access to the document checklist.</p>

  return (
    <section>
      <h1>Documents</h1>
      <p className="muted">
        Tax and payroll forms for each person: collected by upload link or by hand, sent to Finance, and deleted from
        the app once Finance accepts them. <Link to="/documents/settings">Settings</Link>
      </p>

      <section className="card wide">
        <h2>With Finance</h2>
        {queue.isPending ? <p className="muted">Loading…</p> : null}
        {queue.error ? <p className="error">{errorText(queue.error)}</p> : null}
        {queue.data ? (
          queue.data.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Form</th>
                    <th>Person</th>
                    <th>Production</th>
                    <th>Sent</th>
                  </tr>
                </thead>
                <tbody>
                  {queue.data.map((r) => (
                    <tr key={r.documentId}>
                      <td>{DOCUMENT_TYPE_LABELS[r.documentType]}</td>
                      <td>
                        <Link to={`/engagements/${r.engagementId}`}>{displayName(r)}</Link>
                      </td>
                      <td>{r.productionTitle}</td>
                      <td>{r.sentToFinanceAt?.toLocaleDateString() ?? '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">Nothing is waiting on Finance.</p>
          )
        ) : null}
      </section>

      <section className="card wide">
        <h2>By production</h2>
        {seasons.data ? <ProductionLinks seasonIds={seasons.data.map((s) => s.id)} /> : null}
      </section>
    </section>
  )
}

function ProductionLinks({ seasonIds }: { seasonIds: string[] }) {
  return (
    <ul className="plain">
      {seasonIds.map((id) => (
        <SeasonProductions key={id} seasonId={id} />
      ))}
    </ul>
  )
}

function SeasonProductions({ seasonId }: { seasonId: string }) {
  const trpc = useTRPC()
  const data = useQuery(trpc.seasons.dashboard.queryOptions({ id: seasonId }))
  if (!data.data) return null
  return (
    <>
      {data.data.productions.map((p) => (
        <li key={p.id}>
          <Link to={`/productions/${p.id}/documents`}>{p.title}</Link>{' '}
          <span className="muted small">{data.data.season.name}</span>
        </li>
      ))}
    </>
  )
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function DocumentSettingsPage() {
  const trpc = useTRPC()
  const me = useMe()
  const can = useCan()
  const queryClient = useQueryClient()
  const settings = useQuery({ ...trpc.documents.settings.get.queryOptions(), enabled: can('documents') })
  const refresh = () => queryClient.invalidateQueries({ queryKey: trpc.documents.settings.get.queryKey() })
  const saveReqs = useMutation(trpc.documents.settings.saveRequirements.mutationOptions({ onSuccess: refresh }))
  const admin = me.data?.role === ADMIN_ROLE
  if (!can('documents')) return <p className="error">Your role has no access to the document checklist.</p>
  if (settings.isPending) return <p className="muted">Loading…</p>
  if (settings.error) return <p className="error">{errorText(settings.error)}</p>
  const s = settings.data
  const has = (c: ContractType, t: DocumentType) =>
    s.requirements.some((r) => r.contractType === c && r.documentType === t)

  return (
    <section>
      <p className="crumbs">
        <Link to="/documents">Documents</Link>
      </p>
      <h1>Document settings</h1>

      <section className="card wide">
        <h2>Forms needed for each contract type</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Form</th>
                {CONTRACT_TYPES.map((c) => (
                  <th key={c}>{CONTRACT_TYPE_LABELS[c]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {DOCUMENT_TYPES.map((t) => (
                <tr key={t}>
                  <td>{DOCUMENT_TYPE_LABELS[t]}</td>
                  {CONTRACT_TYPES.map((c) => (
                    <td key={c}>
                      <input
                        type="checkbox"
                        aria-label={`${DOCUMENT_TYPE_LABELS[t]} for ${CONTRACT_TYPE_LABELS[c]}`}
                        checked={has(c, t)}
                        disabled={!admin || saveReqs.isPending}
                        onChange={(e) => {
                          const current = DOCUMENT_TYPES.filter((x) => has(c, x))
                          const next = e.target.checked ? [...current, t] : current.filter((x) => x !== t)
                          saveReqs.mutate({ contractType: c, documentTypes: next })
                        }}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {saveReqs.error ? <p className="error">{errorText(saveReqs.error)}</p> : null}
      </section>

      <LinksAndRetention key={`${s.linkDays}-${s.retentionYears}-${s.retentionConfirmed}`} s={s} admin={admin} />
    </section>
  )
}

function LinksAndRetention({
  s,
  admin,
}: {
  s: { linkDays: number; retentionYears: number; retentionConfirmed: boolean }
  admin: boolean
}) {
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const save = useMutation(
    trpc.documents.settings.save.mutationOptions({
      onSuccess: () => queryClient.invalidateQueries({ queryKey: trpc.documents.settings.get.queryKey() }),
    }),
  )
  const [linkDays, setLinkDays] = useState(String(s.linkDays))
  const [years, setYears] = useState(String(s.retentionYears))
  const [confirmed, setConfirmed] = useState(s.retentionConfirmed)
  return (
    <form
      className="card wide"
      onSubmit={(e) => {
        e.preventDefault()
        save.mutate({ linkDays: Number(linkDays), retentionYears: Number(years), retentionConfirmed: confirmed })
      }}
    >
      <h2>Links and deleting files</h2>
      <div className="grid">
        <label>
          Upload links work for (days)
          <input
            type="number"
            min={1}
            max={60}
            value={linkDays}
            disabled={!admin}
            onChange={(e) => setLinkDays(e.target.value)}
          />
        </label>
        <label>
          Delete any form still held this many years after the production closes
          <input
            type="number"
            min={1}
            max={10}
            value={years}
            disabled={!admin}
            onChange={(e) => setYears(e.target.value)}
          />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={confirmed} disabled={!admin} onChange={(e) => setConfirmed(e.target.checked)} />{' '}
        Finance has confirmed this period
      </label>
      {!s.retentionConfirmed ? (
        <p className="banner small">
          {s.retentionYears} years is a starting guess. Finance hasn’t confirmed how long forms may be kept. Forms are
          normally deleted much sooner, the moment Finance accepts them.
        </p>
      ) : null}
      {admin ? (
        <div className="actions">
          <button type="submit" disabled={save.isPending}>
            Save
          </button>
          {save.isSuccess ? <span className="muted small">Saved</span> : null}
        </div>
      ) : (
        <p className="muted small">Only the Company Manager can change these.</p>
      )}
      {save.error ? <p className="error">{errorText(save.error)}</p> : null}
    </form>
  )
}

// ---------------------------------------------------------------------------
// The page behind an upload link. No account, no app chrome.
// ---------------------------------------------------------------------------

export function UploadPage() {
  const { token = '' } = useParams()
  const trpc = useTRPC()
  const queryClient = useQueryClient()
  const data = useQuery({ ...trpc.uploadLink.get.queryOptions({ token }), retry: false })
  const send = useMutation(trpc.uploadLink.send.mutationOptions())
  const [error, setError] = useState<string | null>(null)
  const [sentNames, setSentNames] = useState<Partial<Record<DocumentType, string>>>({})

  return (
    <div className="upload-shell">
      <main className="card">
        {data.isPending ? <p className="muted">Loading…</p> : null}
        {data.error ? (
          <>
            <h1>Upload your forms</h1>
            <p className="error">{errorText(data.error)}</p>
          </>
        ) : null}
        {data.data ? (
          <>
            <h1>Hi {data.data.firstName}</h1>
            <p>
              Please upload your forms for <strong>{data.data.productionTitle}</strong>. A PDF, or a clear photo of each
              page, up to 3 MB.
            </p>
            <p className="muted small">
              Your forms are encrypted and go only to the theatre’s company manager and Finance. The theatre deletes its
              copy once Finance has it on file. This link works until {data.data.expiresAt.toLocaleDateString()}.
            </p>
            <ul className="upload-list">
              {data.data.items.map((item) => (
                <li key={item.documentType}>
                  <div>
                    <strong>{item.label}</strong>
                    {sentNames[item.documentType] ? (
                      <div className="small">Sent: {sentNames[item.documentType]}. Thank you.</div>
                    ) : item.received ? (
                      <div className="small muted">
                        {item.open ? 'Received. You can send a new copy.' : 'Received.'}
                      </div>
                    ) : null}
                    {item.note ? <div className="small">The theatre asked: {item.note}</div> : null}
                  </div>
                  {item.open ? (
                    <input
                      type="file"
                      accept={ACCEPT_ATTRIBUTE}
                      disabled={send.isPending}
                      aria-label={`Upload ${item.label}`}
                      onChange={async (e) => {
                        const file = e.target.files?.[0]
                        e.target.value = ''
                        if (!file) return
                        setError(null)
                        if (file.size > MAX_FILE_BYTES) {
                          setError(TOO_BIG)
                          return
                        }
                        try {
                          await send.mutateAsync({
                            token,
                            documentType: item.documentType,
                            fileName: file.name,
                            base64: await fileToBase64(file),
                          })
                          setSentNames((n) => ({ ...n, [item.documentType]: file.name }))
                          await queryClient.invalidateQueries({ queryKey: trpc.uploadLink.get.queryKey({ token }) })
                        } catch (err) {
                          setError(errorText(err))
                        }
                      }}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
            {send.isPending ? <p className="muted">Uploading…</p> : null}
            {error ? <p className="error">{error}</p> : null}
          </>
        ) : null}
      </main>
    </div>
  )
}
