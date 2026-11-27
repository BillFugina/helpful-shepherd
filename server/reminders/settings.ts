import { eq } from 'drizzle-orm'
import { REMINDER_DEFAULTS, type ReminderSettings } from '../../shared/reminders.js'
import type { Db } from '../db/client.js'
import { reminderSettings } from '../db/schema.js'

export async function loadReminderSettings(db: Db): Promise<ReminderSettings> {
  const [row] = await db.select().from(reminderSettings).where(eq(reminderSettings.id, 1)).limit(1)
  if (!row) return { ...REMINDER_DEFAULTS }
  return {
    paperworkDaysBefore: row.paperworkDaysBefore,
    contractDaysAfter: row.contractDaysAfter,
    digestOn: row.digestOn,
  }
}
