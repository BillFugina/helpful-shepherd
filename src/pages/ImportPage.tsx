import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'
import { guessMapping, parseCsv, type RawRow } from '../../shared/import'
import { IMPORT_COLUMN_LABELS, IMPORT_COLUMNS, type ImportColumn } from '../../shared/roster'
import { errorText } from '../lib/errors'
import { useCan } from '../lib/fields'
import { useTRPC } from '../lib/trpc'

const MAX_ROWS = 500
const REQUIRED: ImportColumn[] = ['legalName', 'role', 'contractType']

/**
 * The one-time import of the personnel sheet: load a CSV export, say which
 * column is which, preview what would happen, then import. Nothing is saved
 * until the preview is clean and you press Import.
 */
export function ImportPage() {
  const { productionId = '' } = useParams()
  const trpc = useTRPC()
  const can = useCan()
  const queryClient = useQueryClient()
  const production = useQuery(trpc.productions.get.queryOptions({ id: productionId }))
  const [fileName, setFileName] = useState<string | null>(null)
  const [table, setTable] = useState<string[][] | null>(null)
  const [mapping, setMapping] = useState<(ImportColumn | null)[]>([])
  const run = useMutation(trpc.import.rows.mutationOptions())

  const headers = table?.[0] ?? []
  const body = useMemo(() => (table ?? []).slice(1), [table])
  const rows: RawRow[] = useMemo(
    () =>
      body.map((cells) => {
        const raw: RawRow = {}
        mapping.forEach((col, i) => {
          if (col && cells[i] !== undefined) raw[col] = cells[i]
        })
        return raw
      }),
    [body, mapping],
  )
  const missing = REQUIRED.filter((c) => !mapping.includes(c))

  async function load(file: File) {
    const text = await file.text()
    const parsed = parseCsv(text)
    setFileName(file.name)
    setTable(parsed)
    setMapping(guessMapping(parsed[0] ?? []))
    run.reset()
  }

  function setColumn(i: number, col: ImportColumn | null) {
    setMapping((m) => m.map((c, j) => (j === i ? col : c === col && col !== null ? null : c)))
    run.reset()
  }

  async function submit(dryRun: boolean) {
    const result = await run.mutateAsync({ productionId, rows, dryRun })
    if (result.imported && production.data) {
      await queryClient.invalidateQueries({
        queryKey: trpc.seasons.dashboard.queryKey({ id: production.data.seasonId }),
      })
      await queryClient.invalidateQueries({ queryKey: trpc.people.list.queryKey() })
    }
  }

  if (production.isPending) return <p className="muted">Loading…</p>
  if (production.error) return <p className="error">{errorText(production.error)}</p>
  if (!can('general', 'edit')) return <p>Your role can't import people.</p>
  const p = production.data
  const result = run.data

  return (
    <section>
      <p className="crumbs">
        <Link to={`/seasons/${p.seasonId}`}>{p.seasonName}</Link> · {p.title}
      </p>
      <h1>Import people into {p.title}</h1>
      <p className="muted">
        Export the personnel sheet as CSV, one row per person, with a header row. People already in the app are matched
        by email, or by name when there's no email.
      </p>

      <label className="card wide">
        CSV file
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void load(f)
          }}
        />
        {fileName ? (
          <span className="muted small">
            {fileName}: {body.length} rows
          </span>
        ) : null}
      </label>

      {table && body.length > MAX_ROWS ? (
        <p className="error">
          That file has {body.length} rows. Import up to {MAX_ROWS} at a time by splitting the sheet.
        </p>
      ) : null}
      {table && body.length === 0 ? <p className="error">That file has a header row but no people.</p> : null}

      {table && body.length > 0 && body.length <= MAX_ROWS ? (
        <>
          <section className="card wide">
            <h2>Which column is which?</h2>
            <p className="muted small">Columns set to “Skip” aren't imported.</p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Column in your file</th>
                    <th>First row</th>
                    <th>Goes into</th>
                  </tr>
                </thead>
                <tbody>
                  {headers.map((h, i) => (
                    <tr key={i}>
                      <td>{h || <span className="muted">(no header)</span>}</td>
                      <td className="muted">{body[0]?.[i] ?? ''}</td>
                      <td>
                        <select
                          aria-label={`Field for ${h}`}
                          value={mapping[i] ?? ''}
                          onChange={(e) => setColumn(i, (e.target.value || null) as ImportColumn | null)}
                        >
                          <option value="">Skip</option>
                          {IMPORT_COLUMNS.map((c) => (
                            <option key={c} value={c}>
                              {IMPORT_COLUMN_LABELS[c]}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {missing.length ? (
              <p className="error">Still needed: {missing.map((c) => IMPORT_COLUMN_LABELS[c]).join(', ')}.</p>
            ) : null}
          </section>

          <div className="actions">
            <button
              type="button"
              className="secondary"
              disabled={missing.length > 0 || run.isPending}
              onClick={() => void submit(true)}
            >
              {run.isPending && run.variables?.dryRun ? 'Checking…' : 'Preview'}
            </button>
            {result && !result.imported && result.counts.error === 0 && result.counts.add > 0 ? (
              <button type="button" disabled={run.isPending} onClick={() => void submit(false)}>
                Import {result.counts.add} {result.counts.add === 1 ? 'person' : 'people'}
              </button>
            ) : null}
          </div>
        </>
      ) : null}

      {run.error ? <p className="error">{errorText(run.error)}</p> : null}

      {result ? (
        <section className="card wide">
          <h2>{result.imported ? 'Imported' : 'Preview'}</h2>
          <p>
            {result.counts.add} {result.imported ? 'added' : 'to add'} · {result.counts.skip} skipped ·{' '}
            {result.counts.error} with problems
          </p>
          {result.imported ? (
            <p>
              <Link to={`/seasons/${p.seasonId}`}>Back to the season</Link>
            </p>
          ) : result.counts.error ? (
            <p className="error">Fix the rows below in the sheet (or the column choices above), then preview again.</p>
          ) : null}
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Name</th>
                  <th>Result</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {result.results.map((r) => (
                  <tr key={r.row} className={`import-${r.status}`}>
                    <td>{r.row}</td>
                    <td>{r.name}</td>
                    <td>{r.status === 'add' ? 'Add' : r.status === 'skip' ? 'Skip' : 'Problem'}</td>
                    <td>
                      {r.status === 'add'
                        ? [
                            r.person === 'existing' ? 'Returning person' : 'New person',
                            r.agent === 'new' ? 'new agent' : r.agent === 'existing' ? 'known agent' : null,
                          ]
                            .filter(Boolean)
                            .join(', ')
                        : r.messages.join(' ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </section>
  )
}
