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
import {
  FORM_FIELDS,
  FORM_SIGNATURES,
  SIGNATURE_FIELDS,
  TEMPLATE_FORMAT_LABELS,
  type FormFormat,
  type ResolvedField,
} from '../../shared/contracts.js'

/**
 * PDFs for contracts, with pdf-lib: reading a blank union form, filling its
 * named fields, and rendering a text template. Nothing here touches the
 * database.
 */

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

async function load(bytes: Uint8Array): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false })
  } catch {
    // pdf-lib's EncryptedPDFError doesn't survive instanceof, so ask the file.
    const locked = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false }).then(
      (d) => d.isEncrypted,
      () => false,
    )
    if (locked) {
      throw new FormError(
        'This PDF is locked by its publisher (encrypted), and the app can’t fill locked forms yet. Equity’s ITC contract is one of these.',
      )
    }
    throw new FormError("That file isn't a PDF the app can read.")
  }
}

export interface FormInfo {
  format: FormFormat
  pages: number
  fields: number
}

function fieldKind(form: PDFForm, name: string): 'text' | 'choice' | 'checkbox' | 'other' | null {
  const field = form.getFieldMaybe(name)
  if (!field) return null
  if (field instanceof PDFTextField) return 'text'
  if (field instanceof PDFRadioGroup || field instanceof PDFDropdown) return 'choice'
  if (field instanceof PDFCheckBox) return 'checkbox'
  return 'other'
}

/**
 * Which union form this is, from its field names, and a check that every
 * field the app fills is there with the right type. A new edition of a form
 * that renames a field is caught here, at upload, not when a contract goes out.
 */
export async function inspectForm(bytes: Uint8Array): Promise<FormInfo> {
  const doc = await load(bytes)
  const form = doc.getForm()
  const names = new Set(form.getFields().map((f) => f.getName()))
  if (!names.size) {
    throw new FormError(
      'This PDF has no fillable fields. Upload the union’s fillable form, or paste the text as a text template.',
    )
  }
  const format = (Object.keys(FORM_SIGNATURES) as FormFormat[]).find((f) =>
    FORM_SIGNATURES[f].every((n) => names.has(n)),
  )
  if (!format) {
    throw new FormError(
      'The app doesn’t recognize this form. It knows the Equity ITC contract and the SDC tier agreement.',
    )
  }
  const problems: string[] = []
  for (const f of FORM_FIELDS[format]) {
    const kind = fieldKind(form, f.name)
    if (kind === null) problems.push(`${f.name} is missing`)
    else if (kind !== f.kind) problems.push(`${f.name} is a ${kind} field, not ${f.kind}`)
    else if (f.kind === 'choice' && f.options) {
      const field = form.getField(f.name) as PDFRadioGroup | PDFDropdown
      const have = field.getOptions()
      const missing = f.options.filter((o) => !have.includes(o))
      if (missing.length) problems.push(`${f.name} has no choice ${missing.join(', ')}`)
    }
  }
  if (problems.length) {
    throw new FormError(
      `This looks like the ${TEMPLATE_FORMAT_LABELS[format]}, but a different edition: ${problems.join('; ')}.`,
    )
  }
  return { format, pages: doc.getPageCount(), fields: names.size }
}

/**
 * The blank form with its fields filled. The form stays a form, so a field
 * can still be corrected in a PDF reader, and nothing else on the page changes.
 */
export async function fillForm(bytes: Uint8Array, fields: readonly ResolvedField[]): Promise<Uint8Array> {
  const doc = await load(bytes)
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
