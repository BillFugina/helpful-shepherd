import { z } from 'zod'

/** Settings for automatic reminders. A count of 0 turns that reminder off. */
export const REMINDER_DEFAULTS = { paperworkDaysBefore: 14, contractDaysAfter: 7, digestOn: true } as const

export const reminderSettingsInput = z.object({
  paperworkDaysBefore: z.number().int().min(0).max(90),
  contractDaysAfter: z.number().int().min(0).max(60),
  digestOn: z.boolean(),
})
export type ReminderSettings = z.infer<typeof reminderSettingsInput>

/** Paperwork reminders go to people at 9 AM theatre time. */
export const PAPERWORK_HOUR = 9
/** The Company Manager's digest goes at 7 AM theatre time. */
export const DIGEST_HOUR = 7
