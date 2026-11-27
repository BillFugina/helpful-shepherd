import { TRPCError } from '@trpc/server'
import { and, desc, eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { ADMIN_ROLE, isGuestUserId } from '../../shared/access.js'
import { sees } from '../alerts/recipients.js'
import { loadAccess } from '../access.js'
import { recordAudit } from '../audit.js'
import { pushSubscription } from '../db/schema.js'
import { isReservedAddress } from '../email/send.js'
import { isPushEndpoint, pushDecision, pushMode, pushToUser, vapidDetails } from '../push/send.js'
import { protectedProcedure, router, staffProcedure } from '../trpc.js'
import { pgCause } from '../writes.js'

/** Devices one login can turn alerts on for. */
export const MAX_DEVICES = 10

const endpoint = z.string().max(1000).refine(isPushEndpoint, 'That isn’t a push address this app accepts.')
// Base64url keys from the browser: p256dh is a 65-byte P-256 point, auth 16 bytes.
const key = (max: number) =>
  z
    .string()
    .min(16)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+=*$/)
const subscription = z.object({
  endpoint,
  keys: z.object({ p256dh: key(120), auth: key(40) }),
})
const deviceLabel = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .transform((s) => s.replace(/[\r\n\t]+/g, ' '))

/** Whether this role gets flight alerts: the Company Manager, when it can see travel. */
const getsFlightAlerts = (role: string, grants: Parameters<typeof sees>[0]) =>
  role === ADMIN_ROLE && sees(grants, 'travel_logistics')

/**
 * Phone alerts (Web Push) for this login: which devices have them on, turning
 * them on and off for a device, and a test alert. Only Company Managers with
 * two-factor on can turn them on; demo logins and the guest never can.
 */
export const pushRouter = router({
  /** What the settings page needs. `endpoint` is this device's, to mark it in the list. */
  status: protectedProcedure
    .input(z.object({ endpoint: z.string().max(1000).optional() }))
    .query(async ({ ctx, input }) => {
      const publicKey = vapidDetails()?.publicKey ?? null
      const mode = pushMode()
      let canTurnOn = false
      let reason: string | null = null
      if (isGuestUserId(ctx.user.id)) reason = 'The guest demo can’t get phone alerts.'
      else if (isReservedAddress(ctx.user.email)) reason = 'Demo logins can’t get phone alerts.'
      else if (!ctx.user.twoFactorEnabled) reason = 'Finish two-factor setup first.'
      else {
        const access = await loadAccess(ctx.db, ctx.user.id)
        if (!access || !getsFlightAlerts(access.role, access.grants)) {
          reason = 'Phone alerts are for the Company Manager.'
        } else if (!publicKey) {
          reason = 'Phone alerts aren’t set up on this server yet.'
        } else canTurnOn = true
      }
      const rows = isGuestUserId(ctx.user.id)
        ? []
        : await ctx.db
            .select({
              id: pushSubscription.id,
              endpoint: pushSubscription.endpoint,
              deviceLabel: pushSubscription.deviceLabel,
              createdAt: pushSubscription.createdAt,
              lastSentAt: pushSubscription.lastSentAt,
            })
            .from(pushSubscription)
            .where(eq(pushSubscription.userId, ctx.user.id))
            .orderBy(desc(pushSubscription.createdAt))
      return {
        publicKey: canTurnOn ? publicKey : null,
        mode,
        canTurnOn,
        reason,
        /** Why alerts that are on won't arrive right now (off, test list), or null. */
        held: canTurnOn ? pushDecision(ctx.user.email) : null,
        // Endpoints stay on the server; the page only learns which row is this device.
        devices: rows.map(({ endpoint: e, ...d }) => ({ ...d, thisDevice: !!input.endpoint && e === input.endpoint })),
      }
    }),

  /** Turns alerts on for this device. A device another login had is moved to this one. */
  subscribe: staffProcedure.input(subscription.extend({ deviceLabel })).mutation(async ({ ctx, input }) => {
    if (isReservedAddress(ctx.user.email)) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Demo logins can’t get phone alerts.' })
    }
    if (!getsFlightAlerts(ctx.role, ctx.grants)) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Phone alerts are for the Company Manager.' })
    }
    if (!vapidDetails()) {
      throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Phone alerts aren’t set up on this server yet.' })
    }
    const [count] = await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(pushSubscription)
      .where(and(eq(pushSubscription.userId, ctx.user.id), sql`${pushSubscription.endpoint} <> ${input.endpoint}`))
    if ((count?.n ?? 0) >= MAX_DEVICES) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: `You can have phone alerts on ${MAX_DEVICES} devices. Remove one first.`,
      })
    }
    const values = {
      userId: ctx.user.id,
      endpoint: input.endpoint,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      deviceLabel: input.deviceLabel,
      failures: 0,
    }
    const [row] = await ctx.db
      .insert(pushSubscription)
      .values(values)
      .onConflictDoUpdate({ target: pushSubscription.endpoint, set: { ...values, createdAt: new Date() } })
      .returning({ id: pushSubscription.id })
    await recordAudit(ctx.db, {
      actorId: ctx.user.id,
      actorEmail: ctx.user.email,
      action: 'create',
      recordType: 'push_subscription',
      recordId: row!.id,
      detail: { device: input.deviceLabel },
    })
    return { id: row!.id }
  }),

  /**
   * Keeps this device's alerts working when the browser changed its keys or
   * address. Only updates a device this login already turned on; it never
   * turns alerts on for a device by itself.
   */
  refresh: staffProcedure
    .input(subscription.extend({ previousEndpoint: endpoint.optional() }))
    .mutation(async ({ ctx, input }) => {
      const match = input.previousEndpoint ?? input.endpoint
      try {
        const updated = await ctx.db
          .update(pushSubscription)
          .set({ endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth, failures: 0 })
          .where(and(eq(pushSubscription.userId, ctx.user.id), eq(pushSubscription.endpoint, match)))
          .returning({ id: pushSubscription.id })
        return { on: updated.length > 0 }
      } catch (err) {
        // The new address is already saved for another row: leave both as they are.
        if (pgCause(err)?.code === '23505') return { on: false }
        throw err
      }
    }),

  /** Turns alerts off for this device (the toggle, and on sign-out). Works whatever the role is now. */
  unsubscribe: protectedProcedure
    .input(z.object({ endpoint: z.string().max(1000) }))
    .mutation(async ({ ctx, input }) => {
      const removed = await ctx.db
        .delete(pushSubscription)
        .where(and(eq(pushSubscription.userId, ctx.user.id), eq(pushSubscription.endpoint, input.endpoint)))
        .returning({ id: pushSubscription.id })
      if (removed.length) {
        await recordAudit(ctx.db, {
          actorId: ctx.user.id,
          actorEmail: ctx.user.email,
          action: 'delete',
          recordType: 'push_subscription',
          recordId: removed[0]!.id,
        })
      }
      return { removed: removed.length }
    }),

  /** Removes one of this login's devices from the list. */
  remove: protectedProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
    const removed = await ctx.db
      .delete(pushSubscription)
      .where(and(eq(pushSubscription.userId, ctx.user.id), eq(pushSubscription.id, input.id)))
      .returning({ id: pushSubscription.id })
    if (removed.length) {
      await recordAudit(ctx.db, {
        actorId: ctx.user.id,
        actorEmail: ctx.user.email,
        action: 'delete',
        recordType: 'push_subscription',
        recordId: input.id,
      })
    }
    return { removed: removed.length }
  }),

  /** A test alert to every device this login turned on, under the same rules as flight alerts. */
  test: staffProcedure.mutation(async ({ ctx }) => {
    return pushToUser(ctx.db, ctx.user.id, {
      title: 'Test alert',
      body: 'Phone alerts work on this device. Flight changes will show up like this.',
      path: '/settings/alerts',
    })
  }),
})
