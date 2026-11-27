import { TRPCError } from '@trpc/server'
import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm'
import { z } from 'zod'
import { filterRecord, levelAtLeast, levelFor, type FieldGroup } from '../../shared/access.js'
import {
  blankFields,
  CONTRACT_FIELDS,
  contactFieldNames,
  FORM_CONTRACT_TYPE,
  markSentInput,
  markSignedInput,
  mergeBody,
  ORGANIZATION_FIELDS,
  organizationInput,
  overridableNames,
  overrideProblem,
  prepareContractsInput,
  saveTextTemplateInput,
  setOverridesInput,
  TEMPLATE_FIELDS,
  unknownTokens,
  uploadFormInput,
  type TemplateFormat,
} from '../../shared/contracts.js'
import { ENGAGEMENT_FIELDS, PIPELINE_STATUSES, type PipelineStatus } from '../../shared/roster.js'
import { recordAudit } from '../audit.js'
import { fillForm, FormError, inspectForm, renderText } from '../contracts/pdf.js'
import {
  contractContext,
  contractOrThrow,
  forDisplay,
  loadOrganization,
  resolvedFields,
  theatreToday,
  valuesToFreeze,
} from '../contracts/service.js'
import type { Db } from '../db/client.js'
import { contract, contractTemplate, engagement, organization, person, production } from '../db/schema.js'
import { router, staffProcedure, type SessionUser } from '../trpc.js'
import { auditChange, friendly, requireEdit, requireView } from '../writes.js'
import { contractSent } from '../reminders/announce.js'

/** Reading a contract shows its pay, so it needs Pay terms as well as Contracts. */
function requireContractView(grants: Parameters<typeof requireView>[0]) {
  requireView(grants, 'contracts')
  requireView(grants, 'general')
  requireView(grants, 'pay_terms')
}

type Grants = Parameters<typeof requireView>[0]
const sees = (grants: Grants, group: FieldGroup) => levelAtLeast(levelFor(grants, group), 'view')

const statusIndex = (s: PipelineStatus) => PIPELINE_STATUSES.indexOf(s)

/** Moves an engagement forward to a status, never back. Logged like any other status change. */
async function advanceEngagement(tx: Db, user: SessionUser, engagementId: string, to: PipelineStatus) {
  const [before] = await tx.select().from(engagement).where(eq(engagement.id, engagementId)).for('update').limit(1)
  if (!before || statusIndex(before.pipelineStatus) >= statusIndex(to)) return false
  await tx.update(engagement).set({ pipelineStatus: to }).where(eq(engagement.id, engagementId))
  await auditChange(tx, user, {
    action: 'update',
    recordType: 'engagement',
    recordId: engagementId,
    personId: before.personId,
    keys: ['pipelineStatus'],
    fields: ENGAGEMENT_FIELDS,
    detail: { from: before.pipelineStatus, to, because: 'contract' },
  })
  return true
}

function templateSummary(t: typeof contractTemplate.$inferSelect) {
  return {
    ...filterRecord(
      {
        id: t.id,
        familyId: t.familyId,
        name: t.name,
        format: t.format,
        contractType: t.contractType,
        version: t.version,
        fileName: t.fileName,
        body: t.body,
        active: t.active,
      },
      TEMPLATE_FIELDS,
      { contracts: 'view' },
    ),
    pdfBytes: t.pdf?.length ?? null,
    createdAt: t.createdAt,
  }
}

async function auditTemplate(
  db: Db,
  user: SessionUser,
  action: 'create' | 'update',
  id: string,
  keys: string[],
  detail?: Record<string, unknown>,
) {
  await auditChange(db, user, {
    action,
    recordType: 'contract_template',
    recordId: id,
    keys,
    fields: TEMPLATE_FIELDS,
    detail,
  })
}

/**
 * The next version of a template family, or a new family. The old version is
 * retired and its draft contracts move to the new one; sent and signed
 * contracts stay with the version that went out.
 */
async function insertTemplateVersion(
  tx: Db,
  user: SessionUser,
  values: Omit<typeof contractTemplate.$inferInsert, 'familyId' | 'version'>,
  replacesId: string | undefined,
): Promise<string> {
  let familyId: string | undefined
  let version = 1
  if (replacesId) {
    const [old] = await tx
      .select()
      .from(contractTemplate)
      .where(eq(contractTemplate.id, replacesId))
      .for('update')
      .limit(1)
    if (!old) throw new TRPCError({ code: 'NOT_FOUND', message: 'That template no longer exists.' })
    if (old.format !== values.format) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'A new version has to be the same kind of form as the old one.',
      })
    }
    const [latest] = await tx
      .select({ version: contractTemplate.version })
      .from(contractTemplate)
      .where(eq(contractTemplate.familyId, old.familyId))
      .orderBy(desc(contractTemplate.version))
      .limit(1)
    familyId = old.familyId
    version = (latest?.version ?? old.version) + 1
    await tx.update(contractTemplate).set({ active: false }).where(eq(contractTemplate.familyId, old.familyId))
  }
  const [row] = await tx
    .insert(contractTemplate)
    .values({ ...values, familyId: familyId ?? crypto.randomUUID(), version, createdBy: user.id })
    .returning({ id: contractTemplate.id, familyId: contractTemplate.familyId })
  if (!replacesId) {
    // A new family's id is its first version's id, so the family is easy to find.
    await tx.update(contractTemplate).set({ familyId: row!.id }).where(eq(contractTemplate.id, row!.id))
  } else {
    // Drafts move to the new version, dropping anything typed over a field
    // or token it no longer has.
    const allowed = overridableNames({ format: values.format as TemplateFormat, body: values.body ?? null })
    const drafts = await tx
      .select({ id: contract.id, overrides: contract.overrides })
      .from(contract)
      .where(and(eq(contract.templateFamilyId, row!.familyId), eq(contract.status, 'draft')))
      .for('update')
    for (const d of drafts) {
      const overrides = Object.fromEntries(Object.entries(d.overrides).filter(([name]) => allowed.has(name)))
      await tx.update(contract).set({ templateId: row!.id, overrides }).where(eq(contract.id, d.id))
    }
  }
  await auditTemplate(
    tx,
    user,
    'create',
    row!.id,
    Object.keys(values).filter((k) => k in TEMPLATE_FIELDS),
    {
      version,
      replacesId: replacesId ?? null,
    },
  )
  return row!.id
}

const organizationRouter = router({
  get: staffProcedure.query(async ({ ctx }) => {
    requireView(ctx.grants, 'contracts')
    return loadOrganization(ctx.db)
  }),

  save: staffProcedure.input(organizationInput).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, ['contracts'])
    const keys = Object.keys(input).filter((k) => input[k as keyof typeof input] !== undefined)
    return friendly(() =>
      ctx.db.transaction(async (tx) => {
        await tx
          .insert(organization)
          .values({ id: 1, ...input })
          .onConflictDoUpdate({ target: organization.id, set: input })
        await auditChange(tx, ctx.user, {
          action: 'update',
          recordType: 'organization',
          recordId: '1',
          keys,
          fields: ORGANIZATION_FIELDS,
        })
        return { ok: true }
      }),
    )
  }),
})

const templatesRouter = router({
  list: staffProcedure.query(async ({ ctx }) => {
    requireView(ctx.grants, 'contracts')
    const rows = await ctx.db
      .select()
      .from(contractTemplate)
      .orderBy(desc(contractTemplate.active), asc(contractTemplate.name), desc(contractTemplate.version))
    return rows.map(templateSummary)
  }),

  /** A blank union form. The app recognizes the form and checks every field it fills is there. */
  uploadForm: staffProcedure.input(uploadFormInput).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, ['contracts'])
    const bytes = Buffer.from(input.pdfBase64, 'base64')
    let format: Exclude<TemplateFormat, 'text'>
    try {
      format = (await inspectForm(bytes)).format
    } catch (error) {
      if (error instanceof FormError) throw new TRPCError({ code: 'BAD_REQUEST', message: error.message })
      throw error
    }
    return friendly(() =>
      ctx.db.transaction(async (tx) => {
        const id = await insertTemplateVersion(
          tx,
          ctx.user,
          {
            name: input.name,
            format,
            contractType: FORM_CONTRACT_TYPE[format],
            pdf: bytes,
            fileName: input.fileName,
          },
          input.replacesId,
        )
        return { id, format }
      }),
    )
  }),

  saveText: staffProcedure.input(saveTextTemplateInput).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, ['contracts'])
    const unknown = unknownTokens(input.body)
    if (unknown.length) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `The template uses ${unknown.map((t) => `{{${t}}}`).join(', ')}, which the app can't fill.`,
      })
    }
    return friendly(() =>
      ctx.db.transaction(async (tx) => {
        const id = await insertTemplateVersion(
          tx,
          ctx.user,
          { name: input.name, format: 'text', contractType: input.contractType, body: input.body },
          input.replacesId,
        )
        return { id }
      }),
    )
  }),

  /** Stops a template being offered for new contracts. Contracts made from it keep it. */
  retire: staffProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, ['contracts'])
    return friendly(() =>
      ctx.db.transaction(async (tx) => {
        const [row] = await tx
          .update(contractTemplate)
          .set({ active: false })
          .where(eq(contractTemplate.id, input.id))
          .returning({ id: contractTemplate.id })
        if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'That template no longer exists.' })
        await auditTemplate(tx, ctx.user, 'update', input.id, ['active'])
        return { id: input.id }
      }),
    )
  }),
})

/**
 * Overrides can hold pay (a typed Compensation, say) or a typed email, so
 * they go out only with Pay terms, and those typed over Contact fields only
 * with Contact as well.
 */
function visibleOverrides(row: { contract: ContractRow; template: TemplateRow }, grants: Grants) {
  if (!sees(grants, 'pay_terms')) return undefined
  const template = { format: row.template.format as TemplateFormat, body: row.template.body }
  // Only names this version can take: one left over from an older version
  // (an {{employee.email}} since removed, say) is never shown.
  const allowed = overridableNames(template)
  if (!sees(grants, 'contact')) for (const name of contactFieldNames(template)) allowed.delete(name)
  return Object.fromEntries(Object.entries(row.contract.overrides).filter(([name]) => allowed.has(name)))
}

type ContractRow = typeof contract.$inferSelect
type TemplateRow = typeof contractTemplate.$inferSelect

function contractSummary(row: { contract: ContractRow; template: TemplateRow }, grants: Grants) {
  return {
    ...filterRecord(
      {
        id: row.contract.id,
        engagementId: row.contract.engagementId,
        templateId: row.contract.templateId,
        status: row.contract.status,
        overrides: visibleOverrides(row, grants),
        sentOn: row.contract.sentOn,
        sentTo: row.contract.sentTo,
        signedOn: row.contract.signedOn,
        voidedAt: row.contract.voidedAt,
      },
      CONTRACT_FIELDS,
      { contracts: 'view' },
    ),
    template: {
      id: row.template.id,
      name: row.template.name,
      format: row.template.format,
      version: row.template.version,
      active: row.template.active,
    },
  }
}

function safeFileName(...parts: string[]): string {
  return `${parts
    .join(' - ')
    .replace(/[^\w .,'()-]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150)}.pdf`
}

export const contractsRouter = router({
  organization: organizationRouter,
  templates: templatesRouter,

  /** An engagement's contracts, and the templates it could still get one from. */
  forEngagement: staffProcedure.input(z.object({ engagementId: z.uuid() })).query(async ({ ctx, input }) => {
    requireView(ctx.grants, 'contracts')
    const [eng] = await ctx.db
      .select({ contractType: engagement.contractType })
      .from(engagement)
      .where(eq(engagement.id, input.engagementId))
      .limit(1)
    if (!eng) throw new TRPCError({ code: 'NOT_FOUND', message: 'That engagement no longer exists.' })
    const rows = await ctx.db
      .select({ contract, template: contractTemplate })
      .from(contract)
      .innerJoin(contractTemplate, eq(contractTemplate.id, contract.templateId))
      .where(eq(contract.engagementId, input.engagementId))
      .orderBy(asc(contract.createdAt))
    const live = new Set(rows.filter((r) => r.contract.status !== 'void').map((r) => r.contract.templateFamilyId))
    const templates = await ctx.db
      .select({ id: contractTemplate.id, familyId: contractTemplate.familyId, name: contractTemplate.name })
      .from(contractTemplate)
      .where(and(eq(contractTemplate.active, true), eq(contractTemplate.contractType, eng.contractType)))
      .orderBy(asc(contractTemplate.name))
    return {
      contracts: rows.map((r) => contractSummary(r, ctx.grants)),
      toPrepare: templates.filter((t) => !live.has(t.familyId)).map((t) => ({ id: t.id, name: t.name })),
    }
  }),

  /** Draft contracts from every active template for this engagement's contract type it doesn't have yet. */
  prepare: staffProcedure.input(prepareContractsInput).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, ['contracts'])
    return friendly(() =>
      ctx.db.transaction(async (tx) => {
        const [eng] = await tx.select().from(engagement).where(eq(engagement.id, input.engagementId)).limit(1)
        if (!eng) throw new TRPCError({ code: 'NOT_FOUND', message: 'That engagement no longer exists.' })
        const templates = await tx
          .select()
          .from(contractTemplate)
          .where(and(eq(contractTemplate.active, true), eq(contractTemplate.contractType, eng.contractType)))
        if (!templates.length) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'There are no contract templates for this contract type yet. Add one under Contract templates.',
          })
        }
        const existing = await tx
          .select({ familyId: contract.templateFamilyId })
          .from(contract)
          .where(and(eq(contract.engagementId, eng.id), ne(contract.status, 'void')))
        const have = new Set(existing.map((e) => e.familyId))
        const created: string[] = []
        for (const t of templates) {
          if (have.has(t.familyId)) continue
          const [row] = await tx
            .insert(contract)
            .values({ engagementId: eng.id, templateId: t.id, templateFamilyId: t.familyId, createdBy: ctx.user.id })
            .returning({ id: contract.id })
          await auditChange(tx, ctx.user, {
            action: 'create',
            recordType: 'contract',
            recordId: row!.id,
            personId: eng.personId,
            keys: ['status'],
            fields: CONTRACT_FIELDS,
            detail: { templateId: t.id },
          })
          created.push(row!.id)
        }
        return { created }
      }),
    )
  }),

  get: staffProcedure.input(z.object({ id: z.uuid() })).query(async ({ ctx, input }) => {
    requireContractView(ctx.grants)
    const row = await contractOrThrow(ctx.db, input.id)
    const { fields, context } = await resolvedFields(ctx.db, row)
    return {
      contract: contractSummary(row, ctx.grants),
      engagement: {
        id: context.engagement.id,
        role: context.engagement.role,
        contractType: context.engagement.contractType,
        pipelineStatus: context.engagement.pipelineStatus,
      },
      person: {
        id: context.person.id,
        legalName: context.person.legalName,
        preferredName: context.person.preferredName,
      },
      production: { id: context.production.id, title: context.production.title, seasonId: context.production.seasonId },
      fields: forDisplay(fields, { seesContact: sees(ctx.grants, 'contact') }),
      blanks: blankFields(fields).map((f) => f.label),
    }
  }),

  /** Values typed over what the app fills in. Drafts only: a sent contract is what went out. */
  setOverrides: staffProcedure.input(setOverridesInput).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, ['contracts'])
    return friendly(() =>
      ctx.db.transaction(async (tx) => {
        const row = await contractOrThrow(tx, input.id, { lock: true })
        if (row.contract.status !== 'draft') {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'Only a draft can be changed. Void it and start a new one.',
          })
        }
        const template = { format: row.template.format as TemplateFormat, body: row.template.body }
        // Without Contact access the page never saw what was typed over a
        // Contact field, so those stay as they were.
        let overrides = input.overrides
        if (!sees(ctx.grants, 'contact')) {
          const contactNames = contactFieldNames(template)
          overrides = Object.fromEntries([
            ...Object.entries(input.overrides).filter(([name]) => !contactNames.has(name)),
            ...Object.entries(row.contract.overrides).filter(([name]) => contactNames.has(name)),
          ])
        }
        for (const [name, value] of Object.entries(overrides)) {
          const problem = overrideProblem(template, name, value)
          if (problem) throw new TRPCError({ code: 'BAD_REQUEST', message: problem })
        }
        await tx.update(contract).set({ overrides }).where(eq(contract.id, input.id))
        const [eng] = await tx
          .select({ personId: engagement.personId })
          .from(engagement)
          .where(eq(engagement.id, row.contract.engagementId))
        await auditChange(tx, ctx.user, {
          action: 'update',
          recordType: 'contract',
          recordId: input.id,
          personId: eng?.personId,
          keys: ['overrides'],
          fields: CONTRACT_FIELDS,
          detail: { names: Object.keys(overrides) },
        })
        return { id: input.id }
      }),
    )
  }),

  /**
   * The filled PDF. It carries the person's home address, email and pay, so it
   * needs Personal ID, Contact and Pay terms as well as Contracts (each only when
   * the form uses it), and every download is logged.
   */
  download: staffProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    requireContractView(ctx.grants)
    const row = await contractOrThrow(ctx.db, input.id)
    const { fields, context } = await resolvedFields(ctx.db, row)
    const personal = fields.some((f) => f.personal && f.value)
    if (personal) requireView(ctx.grants, 'personal_id')
    const contact = fields.some((f) => f.contact && f.value)
    if (contact) requireView(ctx.grants, 'contact')
    let bytes: Uint8Array
    try {
      if (row.template.format === 'text') {
        const values = Object.fromEntries(fields.map((f) => [f.name, f.value]))
        bytes = await renderText(row.template.name, mergeBody(row.template.body ?? '', values))
      } else {
        bytes = await fillForm(row.template.pdf!, fields)
      }
    } catch (error) {
      if (error instanceof FormError) throw new TRPCError({ code: 'BAD_REQUEST', message: error.message })
      throw error
    }
    const groups: FieldGroup[] = [
      'contracts',
      'pay_terms',
      ...(personal ? (['personal_id'] as const) : []),
      ...(contact ? (['contact'] as const) : []),
    ]
    for (const fieldGroup of groups) {
      await recordAudit(ctx.db, {
        actorId: ctx.user.id,
        actorEmail: ctx.user.email,
        action: 'download',
        recordType: 'contract',
        recordId: row.contract.id,
        personId: context.person.id,
        fieldGroup,
        detail: { templateId: row.template.id, status: row.contract.status },
      })
    }
    return {
      fileName: safeFileName(context.production.title, context.person.legalName, row.template.name),
      base64: Buffer.from(bytes).toString('base64'),
    }
  }),

  /**
   * Records that the contract went out (the app doesn't email it). Refused
   * while a required field is blank. Moves the engagement to Contract sent.
   */
  markSent: staffProcedure.input(markSentInput).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, ['contracts', 'general'])
    const sent = await friendly(() =>
      ctx.db.transaction(async (tx) => {
        const row = await contractOrThrow(tx, input.id, { lock: true })
        if (row.contract.status !== 'draft') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'This contract was already sent or voided.' })
        }
        const loaded = await contractContext(tx, row.contract.engagementId, input.sentOn)
        const { fields } = await resolvedFields(tx, { ...row, contract: { ...row.contract, sentOn: input.sentOn } })
        const blanks = blankFields(fields)
        if (blanks.length) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: `Fill these before it goes out: ${blanks.map((f) => f.label).join(', ')}.`,
          })
        }
        await tx
          .update(contract)
          .set({
            status: 'sent',
            sentOn: input.sentOn,
            sentAt: new Date(),
            sentTo: input.sentTo,
            sentValues: valuesToFreeze(fields),
          })
          .where(eq(contract.id, input.id))
        await recordAudit(tx, {
          actorId: ctx.user.id,
          actorEmail: ctx.user.email,
          action: 'send',
          recordType: 'contract',
          recordId: input.id,
          personId: loaded.person.id,
          fieldGroup: 'contracts',
          detail: { fields: ['status', 'sentOn', 'sentTo'], templateId: row.template.id },
        })
        const moved = await advanceEngagement(tx, ctx.user, row.contract.engagementId, 'contract_sent')
        return { id: input.id, movedTo: moved ? ('contract_sent' as const) : null }
      }),
    )
    // Book the digest for the morning it would turn late. Signed by then, it isn't mentioned.
    await contractSent(ctx.db, input.sentOn)
    return sent
  }),

  /**
   * Records a signed copy back. When every live contract on the engagement is
   * signed, the engagement moves to Contract signed.
   */
  markSigned: staffProcedure.input(markSignedInput).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, ['contracts', 'general'])
    return friendly(() =>
      ctx.db.transaction(async (tx) => {
        const row = await contractOrThrow(tx, input.id, { lock: true })
        if (row.contract.status !== 'sent') {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Only a sent contract can be marked signed.' })
        }
        if (row.contract.sentOn && input.signedOn < row.contract.sentOn) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'It can’t be signed before it was sent.' })
        }
        await tx.update(contract).set({ status: 'signed', signedOn: input.signedOn }).where(eq(contract.id, input.id))
        const [eng] = await tx
          .select({ personId: engagement.personId })
          .from(engagement)
          .where(eq(engagement.id, row.contract.engagementId))
        await auditChange(tx, ctx.user, {
          action: 'update',
          recordType: 'contract',
          recordId: input.id,
          personId: eng?.personId,
          keys: ['status', 'signedOn'],
          fields: CONTRACT_FIELDS,
          detail: { from: 'sent', to: 'signed' },
        })
        const open = await tx
          .select({ id: contract.id })
          .from(contract)
          .where(and(eq(contract.engagementId, row.contract.engagementId), inArray(contract.status, ['draft', 'sent'])))
        const moved = open.length
          ? false
          : await advanceEngagement(tx, ctx.user, row.contract.engagementId, 'contract_signed')
        return { id: input.id, movedTo: moved ? ('contract_signed' as const) : null }
      }),
    )
  }),

  /** Cancels a contract (a mistake, or terms that changed). The record stays; a new draft can be prepared. */
  void: staffProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    requireEdit(ctx.grants, ['contracts'])
    return friendly(() =>
      ctx.db.transaction(async (tx) => {
        const row = await contractOrThrow(tx, input.id, { lock: true })
        if (row.contract.status === 'void') return { id: input.id }
        await tx.update(contract).set({ status: 'void', voidedAt: new Date() }).where(eq(contract.id, input.id))
        const [eng] = await tx
          .select({ personId: engagement.personId })
          .from(engagement)
          .where(eq(engagement.id, row.contract.engagementId))
        await auditChange(tx, ctx.user, {
          action: 'update',
          recordType: 'contract',
          recordId: input.id,
          personId: eng?.personId,
          keys: ['status', 'voidedAt'],
          fields: CONTRACT_FIELDS,
          detail: { from: row.contract.status, to: 'void' },
        })
        return { id: input.id }
      }),
    )
  }),

  /** Where every contract on a production stands, person by person. */
  byProduction: staffProcedure.input(z.object({ productionId: z.uuid() })).query(async ({ ctx, input }) => {
    requireView(ctx.grants, 'contracts')
    requireView(ctx.grants, 'general')
    const [prod] = await ctx.db
      .select({ id: production.id, title: production.title })
      .from(production)
      .where(eq(production.id, input.productionId))
      .limit(1)
    if (!prod) throw new TRPCError({ code: 'NOT_FOUND', message: 'That production no longer exists.' })
    const engagements = await ctx.db
      .select({
        id: engagement.id,
        role: engagement.role,
        contractType: engagement.contractType,
        pipelineStatus: engagement.pipelineStatus,
        personId: person.id,
        legalName: person.legalName,
        preferredName: person.preferredName,
      })
      .from(engagement)
      .innerJoin(person, eq(person.id, engagement.personId))
      .where(eq(engagement.productionId, input.productionId))
      .orderBy(asc(person.legalName))
    const ids = engagements.map((e) => e.id)
    const rows = ids.length
      ? await ctx.db
          .select({ contract, template: contractTemplate })
          .from(contract)
          .innerJoin(contractTemplate, eq(contractTemplate.id, contract.templateId))
          .where(and(inArray(contract.engagementId, ids), ne(contract.status, 'void')))
          .orderBy(asc(contractTemplate.name))
      : []
    const byEngagement = new Map<string, ReturnType<typeof contractSummary>[]>()
    for (const r of rows) {
      const list = byEngagement.get(r.contract.engagementId) ?? []
      list.push(contractSummary(r, ctx.grants))
      byEngagement.set(r.contract.engagementId, list)
    }
    const seesPeople = sees(ctx.grants, 'general')
    return {
      production: prod,
      today: theatreToday(),
      engagements: engagements.map((e) => ({
        ...e,
        legalName: seesPeople ? e.legalName : undefined,
        contracts: byEngagement.get(e.id) ?? [],
      })),
    }
  }),
})
