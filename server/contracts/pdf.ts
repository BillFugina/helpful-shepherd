import {
  PDFCheckBox,
  PDFDocument,
  PDFDropdown,
  PDFRadioGroup,
  PDFTextField,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFForm,
  type PDFPage,
} from 'pdf-lib'
import { getDocument, PasswordException, VerbosityLevel, type PDFDocumentProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import * as pdfjsWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs'
import {
  FORM_FIELDS,
  FORM_SIGNATURES,
  SIGNATURE_FIELDS,
  TEMPLATE_FORMAT_LABELS,
  type FormFormat,
  type ResolvedField,
} from '../../shared/contracts.js'

/**
 * PDFs for contracts: reading a blank union form, filling its named fields,
 * and rendering a text template. Nothing here touches the database.
 *
 * pdf-lib does the work, except for forms their publisher has locked
 * (encrypted, as Equity's ITC contract is). pdf-lib can't write those, so
 * PDF.js fills them and saves the result with the same lock, the way a PDF
 * reader would.
 */

// PDF.js runs its parser in the same process on the server. Handing it the
// worker module here (rather than letting it load one by path) keeps the file
// in the deployed bundle.
;(globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = pdfjsWorker

export class FormError extends Error {}

/**
 * The standard PDF fonts only carry Windows-1252 characters. Curly quotes and
 * dashes become their plain forms; anything else that can't print becomes "?".
 */
export function printable(value: string): string {
  return value
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/[^\n\r\t\x20-\x7e\u00a1-\u00ff]/g, '?')
}

/** pdf-lib's document, or null when the publisher locked the file. */
async function load(bytes: Uint8Array): Promise<PDFDocument | null> {
  // A locked file names its lock in the trailer. Checking first spares pdf-lib
  // a full parse that would only log a warning for every encrypted object.
  if (Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).includes('/Encrypt')) return null
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false })
  } catch (error) {
    // pdf-lib's EncryptedPDFError doesn't survive instanceof, so go by its message.
    if (error instanceof Error && /is encrypted/i.test(error.message)) return null
    throw new FormError("That file isn't a PDF the app can read.")
  }
}

/** A locked form, opened with PDF.js. Its fields are listed by name, one entry per widget. */
interface LockedForm {
  doc: PDFDocumentProxy
  fields: Map<string, LockedWidget[]>
  close: () => Promise<void>
}

interface LockedWidget {
  id?: string
  type?: string
  /** A radio button's or checkbox's "on" value. */
  exportValues?: string
  buttonValue?: string
  charLimit?: number
  items?: { exportValue: string; displayValue: string }[]
}

async function openLocked(bytes: Uint8Array): Promise<LockedForm> {
  // PDF.js takes ownership of the buffer it's given, so it gets a copy.
  const task = getDocument({ data: bytes.slice(), verbosity: VerbosityLevel.ERRORS })
  let doc: PDFDocumentProxy
  try {
    doc = await task.promise
  } catch (error) {
    await task.destroy()
    if (error instanceof PasswordException) {
      throw new FormError('This PDF needs a password to open. Upload the union’s blank form as they publish it.')
    }
    throw new FormError("That file isn't a PDF the app can read.")
  }
  const fields = ((await doc.getFieldObjects()) ?? new Map()) as Map<string, LockedWidget[]>
  return { doc, fields, close: () => task.destroy() }
}

const onValue = (w: LockedWidget) => w.exportValues ?? w.buttonValue

export interface FormInfo {
  format: FormFormat
  pages: number
  fields: number
}

/** What the app needs to know about a form field, whichever library read it. */
interface FieldShape {
  kind: 'text' | 'choice' | 'checkbox' | 'other'
  options: string[]
}

function pdfLibShapes(form: PDFForm): Map<string, FieldShape> {
  const out = new Map<string, FieldShape>()
  for (const field of form.getFields()) {
    const shape: FieldShape =
      field instanceof PDFTextField
        ? { kind: 'text', options: [] }
        : field instanceof PDFRadioGroup || field instanceof PDFDropdown
          ? { kind: 'choice', options: field.getOptions() }
          : field instanceof PDFCheckBox
            ? { kind: 'checkbox', options: [] }
            : { kind: 'other', options: [] }
    out.set(field.getName(), shape)
  }
  return out
}

function lockedShapes(fields: Map<string, LockedWidget[]>): Map<string, FieldShape> {
  const out = new Map<string, FieldShape>()
  for (const [name, widgets] of fields) {
    const typed = widgets.filter((w) => w.type)
    const type = typed[0]?.type
    const shape: FieldShape =
      type === 'text'
        ? { kind: 'text', options: [] }
        : type === 'radiobutton'
          ? { kind: 'choice', options: typed.map(onValue).filter((v): v is string => Boolean(v)) }
          : type === 'combobox' || type === 'listbox'
            ? { kind: 'choice', options: (typed[0]?.items ?? []).map((i) => i.exportValue) }
            : type === 'checkbox'
              ? { kind: 'checkbox', options: [] }
              : { kind: 'other', options: [] }
    out.set(name, shape)
  }
  return out
}

/**
 * Which union form this is, from its field names, and a check that every
 * field the app fills is there with the right type. A new edition of a form
 * that renames a field is caught here, at upload, not when a contract goes out.
 */
export async function inspectForm(bytes: Uint8Array): Promise<FormInfo> {
  let shapes: Map<string, FieldShape>
  let pages: number
  const doc = await load(bytes)
  if (doc) {
    shapes = pdfLibShapes(doc.getForm())
    pages = doc.getPageCount()
  } else {
    const locked = await openLocked(bytes)
    try {
      shapes = lockedShapes(locked.fields)
      pages = locked.doc.numPages
    } finally {
      await locked.close()
    }
  }
  if (!shapes.size) {
    throw new FormError(
      'This PDF has no fillable fields. Upload the union’s fillable form, or paste the text as a text template.',
    )
  }
  const format = (Object.keys(FORM_SIGNATURES) as FormFormat[]).find((f) =>
    FORM_SIGNATURES[f].every((n) => shapes.has(n)),
  )
  if (!format) {
    throw new FormError(
      'The app doesn’t recognize this form. It knows the Equity ITC contract and the SDC tier agreement.',
    )
  }
  const problems: string[] = []
  for (const f of FORM_FIELDS[format]) {
    const shape = shapes.get(f.name)
    if (!shape) problems.push(`${f.name} is missing`)
    else if (shape.kind !== f.kind) problems.push(`${f.name} is a ${shape.kind} field, not ${f.kind}`)
    else if (f.kind === 'choice' && f.options) {
      const missing = f.options.filter((o) => !shape.options.includes(o))
      if (missing.length) problems.push(`${f.name} has no choice ${missing.join(', ')}`)
    }
  }
  if (problems.length) {
    throw new FormError(
      `This looks like the ${TEMPLATE_FORMAT_LABELS[format]}, but a different edition: ${problems.join('; ')}.`,
    )
  }
  return { format, pages, fields: shapes.size }
}

/**
 * The blank form with its fields filled. The form stays a form, so a field
 * can still be corrected in a PDF reader, and nothing else on the page changes.
 */
export async function fillForm(bytes: Uint8Array, fields: readonly ResolvedField[]): Promise<Uint8Array> {
  const doc = await load(bytes)
  if (!doc) return fillLockedForm(bytes, fields)
  const form = doc.getForm()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  for (const f of fields) {
    const field = form.getFieldMaybe(f.name)
    if (!field) throw new FormError(`The form has no field named ${f.name}.`)
    const value = printable(f.value)
    if (field instanceof PDFTextField) {
      const max = field.getMaxLength()
      field.setText(max !== undefined && value.length > max ? value.slice(0, max) : value || undefined)
    } else if (field instanceof PDFRadioGroup) {
      if (value) field.select(value)
      else field.clear()
    } else if (field instanceof PDFDropdown) {
      if (value) field.select(value)
      else field.clear()
    } else if (field instanceof PDFCheckBox) {
      if (value) field.check()
      else field.uncheck()
    }
  }
  form.updateFieldAppearances(font)
  return doc.save()
}

/** A locked form, filled with PDF.js and saved with its lock in place. Exported for tests: it fills an unlocked form the same way. */
export async function fillLockedForm(bytes: Uint8Array, fields: readonly ResolvedField[]): Promise<Uint8Array> {
  const { doc, fields: widgets, close } = await openLocked(bytes)
  try {
    for (const f of fields) {
      const list = widgets.get(f.name)?.filter((w) => w.id && w.type)
      if (!list?.length) throw new FormError(`The form has no field named ${f.name}.`)
      const value = printable(f.value)
      for (const w of list) {
        if (w.type === 'text') {
          const max = w.charLimit || undefined
          doc.annotationStorage.setValue(w.id!, { value: max && value.length > max ? value.slice(0, max) : value })
        } else if (w.type === 'radiobutton') {
          doc.annotationStorage.setValue(w.id!, { value: Boolean(value) && onValue(w) === value })
        } else if (w.type === 'checkbox') {
          doc.annotationStorage.setValue(w.id!, { value: Boolean(value) })
        } else if (w.type === 'combobox' || w.type === 'listbox') {
          doc.annotationStorage.setValue(w.id!, { value })
        }
      }
    }
    return await doc.saveDocument()
  } finally {
    await close()
  }
}

// ---------------------------------------------------------------------------
// Text templates
// ---------------------------------------------------------------------------

const PAGE = { width: 612, height: 792, margin: 60 }

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = []
  for (const paragraphLine of text.split('\n')) {
    const words = paragraphLine.split(/(\s+)/)
    let line = ''
    for (const word of words) {
      const next = line + word
      if (font.widthOfTextAtSize(next.trimEnd(), size) <= width || !line.trim()) {
        line = next
      } else {
        lines.push(line.trimEnd())
        line = word.trimStart()
      }
    }
    lines.push(line.trimEnd())
  }
  return lines
}

/**
 * A text template, merged, as a plain PDF. A line starting with "# " is a
 * heading; everything else wraps to the page.
 */
export async function renderText(title: string, body: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.setTitle(printable(title))
  const regular = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const width = PAGE.width - PAGE.margin * 2
  let page: PDFPage = doc.addPage([PAGE.width, PAGE.height])
  let y = PAGE.height - PAGE.margin

  const line = (text: string, font: PDFFont, size: number, gap: number) => {
    if (y - size < PAGE.margin) {
      page = doc.addPage([PAGE.width, PAGE.height])
      y = PAGE.height - PAGE.margin
    }
    page.drawText(text, { x: PAGE.margin, y: y - size, size, font, color: rgb(0, 0, 0) })
    y -= size + gap
  }

  for (const raw of printable(body).split('\n')) {
    if (raw.startsWith('# ')) {
      y -= 6
      for (const l of wrap(raw.slice(2), bold, 12, width)) line(l, bold, 12, 4)
    } else if (!raw.trim()) {
      y -= 6
    } else {
      for (const l of wrap(raw, regular, 10, width)) line(l, regular, 10, 3)
    }
  }
  return doc.save()
}

// ---------------------------------------------------------------------------
// Stand-in forms, for the demo and the tests. They carry the same field names
// as the union forms, so the same field maps fill them, but none of the
// unions' wording: the real forms are uploaded by the Company Manager.
// ---------------------------------------------------------------------------

export async function makeStandInForm(format: FormFormat): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.setTitle(`Demo stand-in: ${TEMPLATE_FORMAT_LABELS[format]}`)
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  const form = doc.getForm()
  let page = doc.addPage([PAGE.width, PAGE.height])
  let y = PAGE.height - PAGE.margin

  page.drawText(`DEMO STAND-IN: ${TEMPLATE_FORMAT_LABELS[format].toUpperCase()}`, {
    x: PAGE.margin,
    y,
    size: 12,
    font: bold,
  })
  y -= 16
  page.drawText('Not the union form. Same field names, so the app fills it the same way.', {
    x: PAGE.margin,
    y,
    size: 9,
    font,
  })
  y -= 24

  const row = (label: string) => {
    if (y < PAGE.margin + 20) {
      page = doc.addPage([PAGE.width, PAGE.height])
      y = PAGE.height - PAGE.margin
    }
    page.drawText(label, { x: PAGE.margin, y: y + 4, size: 8, font })
    const at = { x: PAGE.margin + 190, y, width: PAGE.width - PAGE.margin * 2 - 190, height: 16 }
    y -= 21
    return at
  }

  for (const f of FORM_FIELDS[format]) {
    const at = row(f.label)
    if (f.kind === 'text') {
      form.createTextField(f.name).addToPage(page, { ...at, font })
    } else if (f.kind === 'checkbox') {
      form.createCheckBox(f.name).addToPage(page, { ...at, width: 14, height: 14 })
    } else if (format === 'equity_itc_form') {
      const group = form.createRadioGroup(f.name)
      f.options?.forEach((o, i) => {
        group.addOptionToPage(o, page, { x: at.x + i * 90, y: at.y, width: 12, height: 12 })
        page.drawText(o, { x: at.x + i * 90 + 16, y: at.y + 3, size: 8, font })
      })
    } else {
      const dropdown = form.createDropdown(f.name)
      dropdown.addOptions(['--', ...(f.options ?? [])])
      dropdown.addToPage(page, { ...at, font })
    }
  }
  for (const name of SIGNATURE_FIELDS[format]) {
    form.createTextField(name).addToPage(page, { ...row(`${name} (by hand)`), font })
  }
  form.updateFieldAppearances(font)
  return doc.save()
}
