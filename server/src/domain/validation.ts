import { z } from 'zod';
import { cleanLine, cleanMultiline } from './text.js';

export const uuid = z.string().uuid();
/** One line of free text / several lines: cleaned of bidi and invisible characters first (SEC-21), then trimmed and bounded. */
const line = (max: number) => z.string().transform(cleanLine).pipe(z.string().trim().min(1).max(max));
const lines = (max: number) => z.string().transform(cleanMultiline).pipe(z.string().trim().max(max));
const isoDate = z.string().datetime({ offset: true }).nullable();

const windowOk = (v: { opens_at?: string | null; closes_at?: string | null }) =>
  !v.opens_at || !v.closes_at || new Date(v.closes_at) > new Date(v.opens_at);
const windowMsg = { message: 'closes_at must be after opens_at', path: ['closes_at'] };

const eligibilityMode = z.enum(['umoja', 'all', 'list']);
const emailList = z.array(z.string().trim().max(254)).min(1).max(5000);

export const createCampaignBody = z.object({
  title: line(200),
  description: lines(2000).nullable().optional(),
  opens_at: isoDate.optional(),
  closes_at: isoDate.optional(),
  /** Who may vote. Saved with the campaign (omitted = Umoja members only, the default). 'list' needs emails. */
  eligibility: eligibilityMode.optional(),
  emails: emailList.optional(),
  /** Keep title, description, closing time and (until the first vote) candidates editable after the campaign starts. */
  allow_edits_after_start: z.boolean().optional(),
  /** Put an "Abstain (none of the above)" line on the ballot. Draft only; locked once the campaign starts. */
  allow_abstain: z.boolean().optional(),
  /** Resets and permanent deletes need a co-admin's approval. Can be switched on, never off. */
  require_approval: z.boolean().optional(),
  /** Minimum turnout as a percentage of the eligible voters; a result below it is flagged. Needs a vote with a voter list. */
  quorum_percent: z.number().int().min(1).max(100).nullable().optional(),
  /** Nominations (candidate self-nomination) close at this time; they also close when the campaign starts. */
  nominations_close_at: isoDate.optional(),
  /** Who may nominate themselves: null = the same people who may vote. */
  nominate_eligibility: z.enum(['all', 'umoja']).nullable().optional(),
  /** Show the results grouped by region. */
  results_group_by_region: z.boolean().optional(),
}).strict().refine(windowOk, windowMsg)
  .refine((v) => v.eligibility !== 'list' || (v.emails?.length ?? 0) > 0, { message: 'Add at least one email address for a listed vote', path: ['emails'] })
  .refine((v) => v.eligibility === 'list' || v.emails === undefined, { message: 'emails only applies to a listed vote', path: ['emails'] })
  .refine((v) => v.eligibility !== 'all' || v.quorum_percent == null, { message: 'A quorum needs a known list of voters: choose Umoja members or a list of emails', path: ['quorum_percent'] });

export const patchCampaignBody = z.object({
  title: line(200).optional(),
  description: lines(2000).nullable().optional(),
  opens_at: isoDate.optional(),
  closes_at: isoDate.optional(),
  allow_edits_after_start: z.boolean().optional(),
  allow_abstain: z.boolean().optional(),
  quorum_percent: z.number().int().min(1).max(100).nullable().optional(),
  nominations_close_at: isoDate.optional(),
  nominate_eligibility: z.enum(['all', 'umoja']).nullable().optional(),
  results_group_by_region: z.boolean().optional(),
}).strict().refine(windowOk, windowMsg);

export const candidateBody = z.object({
  name: line(120),
  bio: lines(500).optional(),
  /** Which position the candidate stands for. Optional only while the campaign has a single position. */
  position_id: uuid.optional(),
  region_id: uuid.optional(),
}).strict();

export const positionBody = z.object({
  title: line(200),
  description: lines(2000).nullable().optional(),
  seats: z.number().int().min(1).max(50).optional(),
  min_candidates: z.number().int().min(1).max(500).nullable().optional(),
  max_candidates: z.number().int().min(1).max(500).nullable().optional(),
}).strict().refine((v) => v.min_candidates == null || v.max_candidates == null || v.max_candidates >= v.min_candidates, { message: 'The maximum cannot be below the minimum', path: ['max_candidates'] });
export const positionPatchBody = z.object({
  title: line(200).optional(),
  description: lines(2000).nullable().optional(),
  seats: z.number().int().min(1).max(50).optional(),
  min_candidates: z.number().int().min(1).max(500).nullable().optional(),
  max_candidates: z.number().int().min(1).max(500).nullable().optional(),
  /** Nominations for this position: open or closed by hand. */
  status: z.enum(['open', 'closed']).optional(),
}).strict();
export const reorderBody = z.object({ ids: z.array(uuid).min(1).max(200) }).strict();
export const regionBody = z.object({ name: line(80) }).strict();
export const rejectBody = z.object({ reason: z.string().transform(cleanMultiline).pipe(z.string().trim().min(5, 'Give a reason of at least 5 characters').max(1000)) }).strict();
/** A candidate's own profile (the nomination form). The photo travels as a multipart file. */
export const profileBody = z.object({ name: line(120), bio: lines(500).optional(), region_id: uuid }).strict();
export const positionParams = z.object({ id: uuid, pid: uuid });
export const regionParams = z.object({ id: uuid, rid: uuid });
/** Schedule (or clear) the automatic publication of a closed result. */
export const publishScheduleBody = z.object({ publish_at: z.string().datetime({ offset: true }).nullable() }).strict();
export const publishBody = z.object({ acknowledge_below_quorum: z.boolean().optional() }).strict();

/** A candidate withdraws after voting has started: a reason is required and is shown to voters. */
export const withdrawBody = z.object({ reason: z.string().transform(cleanMultiline).pipe(z.string().trim().min(10, 'Give a reason of at least 10 characters').max(1000)) }).strict();
export const candidatePatchBody = z.object({
  name: line(120).optional(),
  bio: lines(500).optional(),
  removePhoto: z.enum(['true', 'false']).optional(),
  region_id: uuid.nullable().optional(),
}).strict();

export const eligibleBody = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('all') }).strict(),
  z.object({ mode: z.literal('umoja') }).strict(),
  z.object({ mode: z.literal('list'), emails: emailList }).strict(),
]);

export const closeBody = z.object({ reason: z.string().transform(cleanMultiline).pipe(z.string().trim().min(10, 'Give a reason of at least 10 characters').max(1000)).optional() }).strict();
export const ackBody = z.object({ note: z.string().transform(cleanMultiline).pipe(z.string().trim().min(10, 'Write what you found, at least 10 characters').max(1000)) }).strict();
export const voteBody = z.object({ candidateId: uuid, positionId: uuid.optional() }).strict();
export const idParams = z.object({ id: uuid });
export const candParams = z.object({ id: uuid, cid: uuid });
export const tokenParams = z.object({ shareToken: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/) });

/** Type-the-title confirmations compare the title EXACTLY (no trimming, no case folding). */
export const permanentDeleteBody = z.object({ confirm_title: z.string().max(200) }).strict();
export const resetBody = z.object({
  confirm_title: z.string().max(200),
  reason: z.string().transform(cleanMultiline).pipe(z.string().trim().min(10, 'Give a reason of at least 10 characters').max(1000)),
  closes_at: z.string().datetime({ offset: true }).nullable().optional(),
}).strict();
