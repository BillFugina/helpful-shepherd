/** Where a connector draft stands. Pending drafts wait on the Company Manager's review. */
export const DRAFT_STATUS_LIST = ['pending', 'accepted', 'dismissed'] as const
export type DraftStatus = (typeof DRAFT_STATUS_LIST)[number]
