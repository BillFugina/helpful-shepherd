import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { EXPORT_TABLES, type ExportSummary } from '../../shared/export'
import { errorText } from '../lib/errors'
import { useTRPC } from '../lib/trpc'

function saveZip(fileName: string, base64: string) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

const label = (name: string) => EXPORT_TABLES.find((t) => t.name === name)?.label ?? name

/** The full data export: everything the theater keeps here, so it owns its data if it moves on. */
export function ExportPage() {
  const trpc = useTRPC()
  const download = useMutation(trpc.export.download.mutationOptions())
  const [includeSensitive, setIncludeSensitive] = useState(false)
  const [last, setLast] = useState<ExportSummary | null>(null)

  async function run() {
    if (
      includeSensitive &&
      !window.confirm(
        'This file will hold dates of birth, home addresses, TSA/KTN and frequent-flyer numbers, and any tax and bank forms the app still holds, unmasked. The export is logged against each person. Download it?',
      )
    ) {
      return
    }
    const { base64, ...summary } = await download.mutateAsync({ includeSensitive })
    saveZip(summary.fileName, base64)
    setLast(summary)
  }

  return (
    <section>
      <h1>Export all data</h1>
      <p>
        One ZIP with everything the theater keeps here: seasons, productions, people, agents, deals, conflicts, travel,
        housing, contracts and their templates, the paperwork checklist, settings, staff and access, and the audit log.
        Each table is a spreadsheet (CSV), and <code>data.json</code> holds the same rows for loading into another
        system. A README inside explains the columns.
      </p>
      <p className="muted">
        Passwords, sign-in keys, connected-app tokens and upload links are never exported. Every export is recorded in
        the audit log.
      </p>
      <div className="card">
        <label className="inline">
          <input type="checkbox" checked={includeSensitive} onChange={(e) => setIncludeSensitive(e.target.checked)} />{' '}
          Include sensitive details
        </label>
        <p className="muted small">
          {includeSensitive
            ? 'Adds dates of birth, home addresses, TSA/KTN and frequent-flyer numbers, and any tax and bank forms not yet accepted by Finance, unmasked. Each person whose details go into the file is logged.'
            : 'Left off, those fields are left out of the file entirely.'}
        </p>
        <div className="actions">
          <button type="button" disabled={download.isPending} onClick={() => void run().catch(() => undefined)}>
            {download.isPending ? 'Building the export…' : 'Download export'}
          </button>
        </div>
        {download.error ? <p className="error">{errorText(download.error)}</p> : null}
      </div>
      {last ? (
        <div className="card">
          <p>
            Downloaded <strong>{last.fileName}</strong> ({Math.ceil(last.bytes / 1024)} KB)
            {last.includesSensitive ? ', with sensitive details.' : '.'}
          </p>
          <ul>
            {last.tables.map((t) => (
              <li key={t.name}>
                {label(t.name)}: {t.rows}
              </li>
            ))}
            <li>Files: {last.files}</li>
          </ul>
          {last.skippedFiles.length ? (
            <p className="warning">
              {last.skippedFiles.length === 1 ? 'One file was' : `${last.skippedFiles.length} files were`} too large to
              fit in one download. The README lists them; open each from the app.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
