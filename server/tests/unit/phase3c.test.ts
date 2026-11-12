import { describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../../src/errors.js';
import { cleanLine, cleanMultiline } from '../../src/domain/text.js';
import { createCampaignBody, candidateBody, resetBody, closeBody } from '../../src/domain/validation.js';
import { idTag, routeLabel, scrub } from '../../src/logSafe.js';
import { formatWindhoek, isoToLocalInput, localInputToIso, offsetMinutes } from '../../../client/src/windhoek.js';

describe('SEC-18: Windhoek time, whatever the zone of the browser or the server', () => {
  it('Windhoek is UTC+2 (CAT, no daylight saving)', () => {
    expect(offsetMinutes(Date.parse('2026-11-12T10:00:00Z'))).toBe(120);
    expect(offsetMinutes(Date.parse('2026-06-15T10:00:00Z'))).toBe(120);   // no summer/winter shift
  });
  it('a time typed in a datetime-local field is read as Windhoek time and stored as the UTC instant', () => {
    expect(localInputToIso('2026-11-12T17:00')).toBe('2026-11-12T15:00:00.000Z');   // 17:00 CAT = 15:00 UTC
    expect(localInputToIso('2026-01-01T00:30')).toBe('2025-12-31T22:30:00.000Z');   // across midnight and a year boundary
    expect(localInputToIso('')).toBeNull();
    expect(localInputToIso('12/11/2026 17:00')).toBeNull();
  });
  it('and shown back as the same Windhoek wall-clock time, labelled CAT', () => {
    expect(isoToLocalInput('2026-11-12T15:00:00.000Z')).toBe('2026-11-12T17:00');
    expect(formatWindhoek('2026-11-12T15:00:00.000Z')).toBe('12 Nov 2026, 17:00 CAT');
    expect(formatWindhoek('2026-12-31T22:30:00Z')).toBe('1 Jan 2027, 00:30 CAT');
    expect(formatWindhoek(null)).toBe('—');
    expect(formatWindhoek('garbage')).toBe('—');
    for (const v of ['2026-03-01T08:15', '2027-07-04T23:59', '2026-12-31T00:00']) expect(isoToLocalInput(localInputToIso(v))).toBe(v);   // round trip
  });
  it('does not depend on the zone this process runs in', () => {
    const prev = process.env.TZ;
    try {
      for (const tz of ['UTC', 'America/New_York', 'Asia/Tokyo']) {
        process.env.TZ = tz;
        expect(localInputToIso('2026-11-12T17:00')).toBe('2026-11-12T15:00:00.000Z');
        expect(formatWindhoek('2026-11-12T15:00:00Z')).toBe('12 Nov 2026, 17:00 CAT');
      }
    } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; }
  });
});

describe('SEC-19: logs carry no tokens and no voter ids', () => {
  const token = 'abcdefghijklmnopqrstuvwxyz0123456789ABCD';
  const oid = '0f1d2c3b-4a59-4687-8795-a4b3c2d1e0f9';

  it('a request is named by its route pattern, not by the URL that was called', () => {
    expect(routeLabel({ baseUrl: '', route: { path: '/:shareToken' }, params: { shareToken: token }, path: `/${token}`, originalUrl: `/api/vote/${token}?x=1` } as never)).toBe('/api/vote/:shareToken');
    // no route matched: long or uuid-like segments are masked
    expect(routeLabel({ baseUrl: '', route: undefined, path: '', originalUrl: `/api/vote/${token}/results?x=1` } as never)).toBe('/api/vote/:id/results');
    expect(routeLabel({ baseUrl: '', route: undefined, path: '', originalUrl: `/api/campaigns/${oid}/close` } as never)).toBe('/api/campaigns/:id/close');
    expect(routeLabel({ baseUrl: '', route: undefined, path: '', originalUrl: '/api/session' } as never)).toBe('/api/session');
  });

  it('the error handler logs the pattern and a scrubbed message', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = { status: () => ({ json: () => undefined }) };
      errorHandler(new Error(`boom for ${token} and ${oid}`), { method: 'POST', baseUrl: '', route: { path: '/:shareToken' }, params: { shareToken: token }, path: `/${token}`, originalUrl: `/api/vote/${token}` } as never, res as never, (() => undefined) as never);
      const line = String(spy.mock.calls[0][0]);
      expect(line).toBe('[error] POST /api/vote/:shareToken: boom for [token] and [id]');
      expect(line).not.toContain(token); expect(line).not.toContain(oid);
    } finally { spy.mockRestore(); }
  });

  it('an account is a short one-way tag: stable, not the id, not reversible by reading', () => {
    expect(idTag(oid)).toMatch(/^[0-9a-f]{10}$/);
    expect(idTag(oid)).toBe(idTag(oid));
    expect(idTag(oid)).not.toBe(idTag('1f1d2c3b-4a59-4687-8795-a4b3c2d1e0f9'));
    expect(scrub(`x ${oid} y ${token}`)).toBe('x [id] y [token]');
    expect(scrub('plain short text')).toBe('plain short text');
  });
});

describe('SEC-21: bidi and invisible characters are stripped from free text', () => {
  const RLO = String.fromCharCode(0x202e); const ZW = String.fromCharCode(0x200b); const LRI = String.fromCharCode(0x2066); const BOM = String.fromCharCode(0xfeff);
  const NUL = String.fromCharCode(0); const LS = String.fromCharCode(0x2028);

  it('cleanLine removes overrides, isolates, zero-width and control characters, folds line breaks, normalises', () => {
    expect(cleanLine(`Ali${RLO}ce ${ZW}Sm${LRI}ith${BOM}${NUL}`)).toBe('Alice Smith');
    expect(cleanLine('Two\nlines\tand   spaces')).toBe('Two lines and spaces');
    expect(cleanLine('Café')).toBe('Café');                // NFC: e + combining acute -> é
    expect(cleanLine('Ndapewa Shikongo')).toBe('Ndapewa Shikongo');    // ordinary text untouched
    expect(cleanLine('Ruth Kandjii (Finance) – Windhoek')).toBe('Ruth Kandjii (Finance) – Windhoek');
  });
  it('cleanMultiline keeps line breaks and tabs, removes the rest', () => {
    expect(cleanMultiline(`line one\r\nline${RLO} two${LS}\tthree`)).toBe('line one\nline two\tthree');
  });
  it('the request schemas apply it: titles, names, bios, descriptions and reasons', () => {
    const t = createCampaignBody.parse({ title: `  Vote${RLO} for${ZW} chair  `, description: `Line 1\r\nLine${LRI} 2` });
    expect(t.title).toBe('Vote for chair'); expect(t.description).toBe('Line 1\nLine 2');
    expect(candidateBody.parse({ name: `Al${RLO}ice`, bio: `bio${ZW}` })).toEqual({ name: 'Alice', bio: 'bio' });
    expect(resetBody.parse({ confirm_title: 'x', reason: `A reason${RLO} that is long enough` }).reason).toBe('A reason that is long enough');
    expect(closeBody.parse({ reason: `Everyone${ZW} has voted already` }).reason).toBe('Everyone has voted already');
  });
  it('a name made only of invisible characters is empty after cleaning, so it is refused', () => {
    expect(candidateBody.safeParse({ name: `${RLO}${ZW}  ${BOM}` }).success).toBe(false);
    expect(createCampaignBody.safeParse({ title: `${ZW}${ZW}` }).success).toBe(false);
  });
  it('the exact-match confirmation fields are NOT cleaned (they must equal the stored title byte for byte)', () => {
    expect(resetBody.parse({ confirm_title: `A${ZW}B`, reason: 'A reason that is long enough' }).confirm_title).toBe(`A${ZW}B`);
  });
});
