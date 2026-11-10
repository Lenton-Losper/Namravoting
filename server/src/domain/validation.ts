import { z } from 'zod';

export const uuid = z.string().uuid();
const isoDate = z.string().datetime({ offset: true }).nullable();

const windowOk = (v: { opens_at?: string | null; closes_at?: string | null }) =>
  !v.opens_at || !v.closes_at || new Date(v.closes_at) > new Date(v.opens_at);
const windowMsg = { message: 'closes_at must be after opens_at', path: ['closes_at'] };

export const createCampaignBody = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  opens_at: isoDate.optional(),
  closes_at: isoDate.optional(),
}).strict().refine(windowOk, windowMsg);

export const patchCampaignBody = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  opens_at: isoDate.optional(),
  closes_at: isoDate.optional(),
}).strict().refine(windowOk, windowMsg);

export const candidateBody = z.object({
  name: z.string().trim().min(1).max(120),
  bio: z.string().trim().max(500).optional(),
}).strict();
export const candidatePatchBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  bio: z.string().trim().max(500).optional(),
  removePhoto: z.enum(['true', 'false']).optional(),
}).strict();

export const eligibleBody = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('all') }).strict(),
  z.object({ mode: z.literal('list'), emails: z.array(z.string().trim().max(254)).min(1).max(5000) }).strict(),
]);

export const voteBody = z.object({ candidateId: uuid }).strict();
export const idParams = z.object({ id: uuid });
export const candParams = z.object({ id: uuid, cid: uuid });
export const tokenParams = z.object({ shareToken: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/) });
