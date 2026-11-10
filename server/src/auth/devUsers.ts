import type { AuthUser } from './types.js';

/** Seeded dev identities (used by `npm run seed` and the client's dev login page). */
export const DEV_USERS: AuthUser[] = [
  { oid: 'a1111111-1111-4111-8111-111111111111', email: 'admin.one@namra.test', displayName: 'Alice Admin', roles: ['CampaignAdmin'], employeeCode: 'EXE0001' },
  { oid: 'a2222222-2222-4222-8222-222222222222', email: 'admin.two@namra.test', displayName: 'Bruno Admin', roles: ['CampaignAdmin'], employeeCode: 'EXE0002' },
  { oid: 'b1111111-1111-4111-8111-111111111111', email: 'staff.one@namra.test', displayName: 'Chantal Staff', roles: [], employeeCode: 'NAM0101' },
  { oid: 'b2222222-2222-4222-8222-222222222222', email: 'staff.two@namra.test', displayName: 'David Staff', roles: [], employeeCode: 'NAM0102' },
  { oid: 'b3333333-3333-4333-8333-333333333333', email: 'staff.three@namra.test', displayName: 'Elize Staff', roles: [], employeeCode: 'NAM0103' },
  { oid: 'b4444444-4444-4444-8444-444444444444', email: 'staff.four@namra.test', displayName: 'Festus Staff', roles: [], employeeCode: 'NAM0104' },
  { oid: 'b5555555-5555-4555-8555-555555555555', email: 'staff.five@namra.test', displayName: 'Gerda Staff', roles: [], employeeCode: null },
];

/**
 * Dev Umoja membership list (loaded by `npm run seed`, as a fake HR import):
 *  Alice, Chantal, David = active members; Elize = inactive member; Bruno, Festus = code not on the list; Gerda = no code at all.
 */
export const DEV_UMOJA_MEMBERS: { code: string; active: boolean }[] = [
  { code: 'EXE0001', active: true },
  { code: 'NAM0101', active: true },
  { code: 'NAM0102', active: true },
  { code: 'NAM0103', active: false },
  { code: 'NAM0999', active: true },   // member who has not signed in yet
];
