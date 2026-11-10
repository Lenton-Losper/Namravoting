import type { AuthUser } from './types.js';

/** Seeded dev identities (used by `npm run seed` and the client's dev login page). */
export const DEV_USERS: AuthUser[] = [
  { oid: 'a1111111-1111-4111-8111-111111111111', email: 'admin.one@namra.test', displayName: 'Alice Admin', roles: ['CampaignAdmin'], employeeCode: 'TST0001' },
  { oid: 'a2222222-2222-4222-8222-222222222222', email: 'admin.two@namra.test', displayName: 'Bruno Admin', roles: ['CampaignAdmin'], employeeCode: 'TST0002' },
  { oid: 'b1111111-1111-4111-8111-111111111111', email: 'staff.one@namra.test', displayName: 'Chantal Staff', roles: [], employeeCode: 'TST0003' },
  { oid: 'b2222222-2222-4222-8222-222222222222', email: 'staff.two@namra.test', displayName: 'David Staff', roles: [], employeeCode: 'TST0004' },
  { oid: 'b3333333-3333-4333-8333-333333333333', email: 'staff.three@namra.test', displayName: 'Elize Staff', roles: [], employeeCode: 'TST0005' },
  { oid: 'b4444444-4444-4444-8444-444444444444', email: 'staff.four@namra.test', displayName: 'Festus Staff', roles: [], employeeCode: 'TST0006' },
  { oid: 'b5555555-5555-4555-8555-555555555555', email: 'staff.five@namra.test', displayName: 'Gerda Staff', roles: [], employeeCode: null },
];

/**
 * Fake Umoja membership list (dev seed and the Cloudflare demo): obviously fake TST codes, about 25 members.
 *  Alice (TST0001), Chantal (TST0003), David (TST0004) = active members; Elize (TST0005) = inactive member;
 *  Bruno (TST0002) and Festus (TST0006) = code not on the list; Gerda = no employee code at all.
 */
export const DEV_UMOJA_MEMBERS: { code: string; active: boolean }[] = [
  { code: 'TST0001', active: true },
  { code: 'TST0003', active: true },
  { code: 'TST0004', active: true },
  { code: 'TST0005', active: false },
  ...Array.from({ length: 21 }, (_, i) => ({ code: `TST${String(i + 7).padStart(4, '0')}`, active: true })),
];
