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
}).strict().refine(windowOk, windowMsg)
  .refine((v) => v.eligibility !== 'list' || (v.emails?.length ?? 0) > 0, { message: 'Add at least one email address for a listed vote', path: ['emails'] })
  .refine((v) => v.eligibility === 'list' || v.emails === undefined, { message: 'emails only applies to a listed vote', path: ['emails'] });

export const patchCampaignBody = z.object({
  title: line(200).optional(),
  description: lines(2000).nullable().optional(),
  opens_at: isoDate.optional(),
  closes_at: isoDate.optional(),
  allow_edits_after_start: z.boolean().optional(),
}).strict().refine(windowOk, windowMsg);

export const candidateBody = z.object({
  name: line(120),
  bio: lines(500).optional(),
}).strict();
export const candidatePatchBody = z.object({
  name: line(120).optional(),
  bio: lines(500).optional(),
  removePhoto: z.enum(['true', 'false']).optional(),
}).strict();

export const eligibleBody = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('all') }).strict(),
  z.object({ mode: z.literal('umoja') }).strict(),
  z.object({ mode: z.literal('list'), emails: emailList }).strict(),
]);

export const closeBody = z.object({ reason: z.string().transform(cleanMultiline).pipe(z.string().trim().min(10, 'Give a reason of at least 10 characters').max(1000)).optional() }).strict();
export const ackBody = z.object({ note: z.string().transform(cleanMultiline).pipe(z.string().trim().min(10, 'Write what you found, at least 10 characters').max(1000)) }).strict();
export const voteBody = z.object({ candidateId: uuid }).strict();
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
