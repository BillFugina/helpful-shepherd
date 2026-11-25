import { CONFLICT_FIELDS, ENGAGEMENT_FIELDS } from '../../shared/roster.js'
import type { agent, conflict, engagement, production, season } from '../db/schema.js'

/*
 * Rows shaped for filterRecord: only the registry's fields, never bookkeeping
 * columns like is_demo. filterRecord then drops whatever the role can't see.
 */

export function seasonRecord(row: typeof season.$inferSelect) {
  const { id, name, program, startsOn, endsOn } = row
  return { id, name, program, startsOn, endsOn }
}

export function productionRecord(row: typeof production.$inferSelect) {
  const { id, seasonId, title, rehearsalStart, techStart, opening, closing, performanceSchedule } = row
  return { id, seasonId, title, rehearsalStart, techStart, opening, closing, performanceSchedule }
}

export function agentRecord(row: typeof agent.$inferSelect) {
  const { id, name, agency, email, phone } = row
  return { id, name, agency, email, phone }
}

type EngagementRow = typeof engagement.$inferSelect
export type EngagementRecord = { [K in keyof typeof ENGAGEMENT_FIELDS]: EngagementRow[K] }

export function engagementRecord(row: EngagementRow): EngagementRecord {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(ENGAGEMENT_FIELDS)) out[key] = row[key as keyof EngagementRow]
  return out as EngagementRecord
}

type ConflictRow = typeof conflict.$inferSelect
export type ConflictRecord = { [K in keyof typeof CONFLICT_FIELDS]: ConflictRow[K] }

export function conflictRecord(row: ConflictRow): ConflictRecord {
  const { id, engagementId, startsOn, endsOn, description } = row
  return { id, engagementId, startsOn, endsOn, description }
}
