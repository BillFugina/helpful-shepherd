import {
  AGENT_FIELDS,
  CONFLICT_FIELDS,
  ENGAGEMENT_FIELDS,
  PRODUCTION_FIELDS,
  SEASON_FIELDS,
} from '../../shared/roster.js'
import type { agent, conflict, engagement, production, season } from '../db/schema.js'

/*
 * Rows shaped for filterRecord: only the registry's fields, never bookkeeping
 * columns like is_demo. filterRecord then drops whatever the role can't see.
 *
 * Each projection is written out field by field and typed as RecordOf its
 * registry, so the two can't drift: a field added to the registry but not
 * here is a missing property, a field here but not in the registry is an
 * excess property, and a registry field the table doesn't have is `never`.
 */

export type RecordOf<Row, Fields> = { [K in keyof Fields]: K extends keyof Row ? Row[K] : never }

export type SeasonRecord = RecordOf<typeof season.$inferSelect, typeof SEASON_FIELDS>
export type ProductionRecord = RecordOf<typeof production.$inferSelect, typeof PRODUCTION_FIELDS>
export type AgentRecord = RecordOf<typeof agent.$inferSelect, typeof AGENT_FIELDS>
export type EngagementRecord = RecordOf<typeof engagement.$inferSelect, typeof ENGAGEMENT_FIELDS>
export type ConflictRecord = RecordOf<typeof conflict.$inferSelect, typeof CONFLICT_FIELDS>

export function seasonRecord(row: typeof season.$inferSelect): SeasonRecord {
  return { id: row.id, name: row.name, program: row.program, startsOn: row.startsOn, endsOn: row.endsOn }
}

export function productionRecord(row: typeof production.$inferSelect): ProductionRecord {
  return {
    id: row.id,
    seasonId: row.seasonId,
    title: row.title,
    rehearsalStart: row.rehearsalStart,
    techStart: row.techStart,
    opening: row.opening,
    closing: row.closing,
    performanceSchedule: row.performanceSchedule,
    venueName: row.venueName,
    venueCapacity: row.venueCapacity,
    topTicketCents: row.topTicketCents,
    scheduledPerformances: row.scheduledPerformances,
    rehearsalLocation: row.rehearsalLocation,
    rehearsalCallTime: row.rehearsalCallTime,
  }
}

export function agentRecord(row: typeof agent.$inferSelect): AgentRecord {
  return { id: row.id, name: row.name, agency: row.agency, email: row.email, phone: row.phone }
}

export function engagementRecord(row: typeof engagement.$inferSelect): EngagementRecord {
  return {
    id: row.id,
    personId: row.personId,
    productionId: row.productionId,
    role: row.role,
    contractType: row.contractType,
    pipelineStatus: row.pipelineStatus,
    agentId: row.agentId,
    weeklyPayCents: row.weeklyPayCents,
    commissionPercent: row.commissionPercent,
    weeklyStipendCents: row.weeklyStipendCents,
    feeCents: row.feeCents,
    travelProvided: row.travelProvided,
    carProvided: row.carProvided,
    housingProvided: row.housingProvided,
    preferredArrival: row.preferredArrival,
    preferredDeparture: row.preferredDeparture,
    scriptNeeded: row.scriptNeeded,
    compAllotment: row.compAllotment,
    notes: row.notes,
  }
}

export function conflictRecord(row: typeof conflict.$inferSelect): ConflictRecord {
  return {
    id: row.id,
    engagementId: row.engagementId,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    description: row.description,
  }
}
