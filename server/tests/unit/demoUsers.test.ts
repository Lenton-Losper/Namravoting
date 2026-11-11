import { describe, expect, it } from 'vitest';
import { demoUserFor, uuidv5 } from '../../src/auth/demoAuth.js';
import { parseDemoUsers } from '../../src/config.js';

describe('uuidv5', () => {
  it('matches the RFC 4122 / python uuid.uuid5 reference vector', () => {
    // python: uuid.uuid5(uuid.NAMESPACE_DNS, 'python.org') == 886313e1-3b8a-5372-9b90-0c9aee199e5d
    expect(uuidv5('python.org', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('886313e1-3b8a-5372-9b90-0c9aee199e5d');
  });
  it('is stable and case-sensitive on its input (callers lower-case)', () => {
    expect(uuidv5('a@b.c')).toBe(uuidv5('a@b.c'));
    expect(uuidv5('a@b.c')).not.toBe(uuidv5('A@b.c'));
  });
});

describe('DEMO_USERS', () => {
  const raw = JSON.stringify({ 'A@Namra.org.na': { displayName: 'Ann', roles: ['CampaignAdmin'], employeeCode: ' tst0001 ' }, 'b@namra.org.na': { displayName: 'Bob' } });
  it('parses, lower-cases emails, normalises codes and defaults roles to none', () => {
    const p = parseDemoUsers(raw);
    expect(p['a@namra.org.na']).toEqual({ displayName: 'Ann', roles: ['CampaignAdmin'], employeeCode: 'TST0001' });
    expect(p['b@namra.org.na']).toEqual({ displayName: 'Bob', roles: [], employeeCode: null });
  });
  it('rejects bad input with a message that names the problem but not secrets', () => {
    expect(() => parseDemoUsers('{nope')).toThrow(/not valid JSON/);
    expect(() => parseDemoUsers('[]')).toThrow(/JSON object/);
    expect(() => parseDemoUsers(JSON.stringify({ 'x@y.z': { displayName: 'X', roles: ['Root'] } }))).toThrow(/x@y\.z.*invalid/);
    expect(() => parseDemoUsers(JSON.stringify({ 'x@y.z': { displayName: 'X', employeeCode: 'bad' } }))).toThrow(/malformed employeeCode/);
  });
  it('unset or blank means no profiles', () => { expect(parseDemoUsers(undefined)).toEqual({}); expect(parseDemoUsers('  ')).toEqual({}); });

  it('demoUserFor: mapped profile, or plain staff named from the email', () => {
    const p = parseDemoUsers(raw);
    expect(demoUserFor(' A@NAMRA.org.na ', p)).toMatchObject({ email: 'a@namra.org.na', displayName: 'Ann', roles: ['CampaignAdmin'], employeeCode: 'TST0001' });
    expect(demoUserFor('jane.doe@namra.org.na', p)).toMatchObject({ displayName: 'Jane Doe', roles: [], employeeCode: null });
  });
});
